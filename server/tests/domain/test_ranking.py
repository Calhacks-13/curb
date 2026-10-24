from app.models.domain import AgentParkingOption, GeoPoint


def test_ranking_prioritizes_driveway_then_freshness_confidence_and_distance():
    from app.domain.ranking import rank_options

    def option(id, freshness="FRESH", confidence=0.9, lng=-122.419, driveway=False):
        return AgentParkingOption(
            id=id, type="DRIVEWAY" if driveway else "CURB",
            location={"type": "Point", "coordinates": [lng, 37.775]}, distance_m=999,
            price_usdc="8.00" if driveway else None, current_rules="Legal now",
            confidence=None if driveway else confidence, freshness=None if driveway else freshness,
            availability="Available" if driveway else "Likely open", reservation_supported=driveway,
        )

    options = [option("aging", "AGING"), option("low", confidence=0.8),
               option("far", lng=-122.420), option("near"), option("driveway", driveway=True)]
    ranked = rank_options(GeoPoint(type="Point", coordinates=(-122.419, 37.775)), options)
    assert [o.id for o in ranked] == ["driveway", "near", "far", "low", "aging"]
    assert ranked[1].distance_m == 0
    assert 87 < ranked[2].distance_m < 89
    assert options[0].distance_m == 999
