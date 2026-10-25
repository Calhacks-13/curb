"""Evidence checks shared by OCR, association, and curb-rule presentation."""
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.models.cv import SignPoleReading

CURB_TYPES = {"parking", "no_parking", "street_cleaning", "meter", "time_limit", "permit", "loading_zone"}
UNREADABLE = re.compile(r"illegible|unreadable|not (?:legible|readable)|cannot (?:read|determine)|too (?:dark|blurry)|low image quality", re.I)
CURB_TEXT = re.compile(r"parking|no\s+stopping|street\s+clean|meter|permit|loading|\bhours?\b|\bminutes?\b|tow.away", re.I)


def curb_sign_usable(sign) -> bool:
    return bool(sign.sign_type in CURB_TYPES and len(sign.raw_text.strip()) >= 4
                and not UNREADABLE.search(sign.raw_text) and CURB_TEXT.search(sign.raw_text))


def has_curb_evidence(reading: SignPoleReading | None) -> bool:
    if reading is None or reading.flagged or reading.confidence_score < 0.5 or reading.sign_category != "street":
        return False
    return any(curb_sign_usable(sign) for sign in reading.signs)


def assess_reading(reading: SignPoleReading) -> SignPoleReading:
    """Completeness alone is not evidence of a readable sign or parking rule."""
    reading = reading.model_copy(deep=True)
    text = " ".join(sign.raw_text for sign in reading.signs)
    if not text.strip() or UNREADABLE.search(text) or UNREADABLE.search(reading.combined_summary):
        reading.flagged = True
        reading.confidence_score = min(reading.confidence_score, 0.25)
        reading.sign_category = "unreadable"
    elif not any(curb_sign_usable(sign) for sign in reading.signs) and reading.sign_category == "street":
        reading.sign_category = "informational"
    elif reading.sign_category in ("garage", "lot") and not re.search(r"parking|garage|\blot\b|car park", text, re.I):
        reading.sign_category = "informational"
    return reading


def reading_identity(reading: SignPoleReading):
    return (reading.sign_category, tuple(sorted(
        (sign.sign_type, re.sub(r"\W+", "", sign.raw_text.casefold())) for sign in reading.signs
    )))


def merge_curb_readings(readings: list[SignPoleReading]) -> SignPoleReading | None:
    valid = [reading for reading in readings if has_curb_evidence(reading)]
    if not valid:
        return None
    if len(valid) == 1:
        return valid[0]
    unique = {reading_identity(reading): reading for reading in valid}.values()
    unique = list(unique)
    signs = {(sign.sign_type, sign.raw_text): sign for reading in unique for sign in reading.signs if curb_sign_usable(sign)}
    limits = [r.combined_max_duration_min for r in unique if r.combined_max_duration_min]
    return SignPoleReading(
        signs=list(signs.values()),
        combined_summary=" · ".join(dict.fromkeys(r.combined_summary for r in unique if r.combined_summary)),
        combined_hours=" · ".join(dict.fromkeys(r.combined_hours for r in unique if r.combined_hours)) or None,
        combined_max_duration_min=min(limits) if limits else None,
        combined_price=" · ".join(dict.fromkeys(r.combined_price for r in unique if r.combined_price)) or None,
        combined_restrictions=list(dict.fromkeys(x for r in unique for x in r.combined_restrictions)),
        confidence_score=min(r.confidence_score for r in unique), sign_category="street",
    )


def rule_text(reading: SignPoleReading | None) -> str:
    if not has_curb_evidence(reading):
        return "No validated parking sign read for this curb."
    # Keep the time/date evidence visible even when the summary omitted it.
    parts = [reading.combined_summary, reading.combined_hours]
    parts.extend(sign.raw_text for sign in reading.signs if curb_sign_usable(sign))
    return "\n".join(dict.fromkeys(part.strip() for part in parts if part and part.strip()))


def rule_summary(reading: SignPoleReading | None) -> str:
    """Display one interpretation; keep raw OCR and hours in rule_text evidence."""
    if not has_curb_evidence(reading):
        return "No validated parking sign read for this curb."
    return reading.combined_summary.strip() or " · ".join(dict.fromkeys(
        sign.raw_text.strip() for sign in reading.signs if curb_sign_usable(sign)
    ))


LA = ZoneInfo("America/Los_Angeles")
DAY = r"mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?"
DAY_INDEX = {name: i for i, name in enumerate(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])}


def evaluate_rule_text(text: str, now: datetime | None = None) -> tuple[str, datetime | None]:
    """Evaluate explicit daily/weekly/nth-weekday windows; unsupported rules stay UNKNOWN.

    This uses the sign's stated schedule, not the mere presence of 'no parking'.
    Permit eligibility, holidays, date ranges and ambiguous clocks are not inferred.
    """
    now = (now or datetime.now(UTC)).astimezone(LA)
    text = re.sub(r"\s+", " ", text.casefold().replace("–", "-").replace("—", "-"))
    if not text.strip() or "no validated parking sign" in text or UNREADABLE.search(text):
        return "UNKNOWN", None
    forbidden = bool(re.search(r"no parking|no stopping|street clean", text))
    if not forbidden and not re.search(r"parking|meter|loading", text):
        return "UNKNOWN", None
    if re.search(r"permit|except|holiday|school|loading|\d\s*/\s*\d|january|february|march|april|june|july|august|september|october|november|december|\bmay\b", text):
        return "UNKNOWN", None
    matches = list(re.finditer(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", text))
    # Repeated summary/raw text may contain the same window more than once.
    windows = set()
    for match in matches:
        h1, m1, am1, h2, m2, am2 = match.groups()
        if bool(am1) != bool(am2) or not am1 and (m1 is None or m2 is None):
            return "UNKNOWN", None
        def minutes(hour, minute, meridiem):
            hour, minute = int(hour), int(minute or 0)
            if minute > 59 or (meridiem and not 1 <= hour <= 12) or (not meridiem and hour > 23):
                raise ValueError("invalid clock")
            return ((hour % 12 + (12 if meridiem == "pm" else 0)) if meridiem else hour) * 60 + minute
        try:
            windows.add((minutes(h1, m1, am1), minutes(h2, m2, am2)))
        except ValueError:
            return "UNKNOWN", None
    days = {DAY_INDEX[match.group()[:3]] for match in re.finditer(rf"\b(?:{DAY})s?\b", text)}
    day_range = re.search(rf"\b({DAY})\s*-\s*({DAY})\b", text)
    if day_range:
        start, end = (DAY_INDEX[part[:3]] for part in day_range.groups())
        days.update((start + offset) % 7 for offset in range((end - start) % 7 + 1))
    ordinals = {int(match.group(1)) for match in re.finditer(r"\b([1-5])(?:st|nd|rd|th)\b", text)}
    for word, number in {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}.items():
        if re.search(rf"\b{word}\s+(?:{DAY})", text):
            ordinals.add(number)
    if len(ordinals) > 1 or ordinals and not days or (re.search(r"month|first|second|third|fourth|fifth|last", text) and not ordinals):
        return "UNKNOWN", None
    ordinal = next(iter(ordinals), None)
    if not windows:
        if days or re.search(r"\d\s*(?:am|pm)|\d:\d|\bhours of\b", text):
            return "UNKNOWN", None
        return ("ILLEGAL" if forbidden else "LEGAL"), None
    if len(windows) != 1:
        return "UNKNOWN", None
    start_minute, end_minute = next(iter(windows))
    if start_minute == end_minute:
        return "UNKNOWN", None
    spans = []
    for offset in range(-1, 66):
        date = now.date() + timedelta(days=offset)
        if days and date.weekday() not in days or ordinal and (date.day - 1) // 7 + 1 != ordinal:
            continue
        start = datetime(date.year, date.month, date.day, tzinfo=LA) + timedelta(minutes=start_minute)
        end = datetime(date.year, date.month, date.day, tzinfo=LA) + timedelta(minutes=end_minute)
        if end <= start:
            end += timedelta(days=1)
        spans.append((start, end))
    active = any(start <= now < end for start, end in spans)
    next_change = min((point for span in spans for point in span if point > now), default=None)
    state = ("ILLEGAL" if active else "LEGAL") if forbidden else ("LEGAL" if active else "UNKNOWN")
    return state, next_change.astimezone(UTC) if next_change else None
