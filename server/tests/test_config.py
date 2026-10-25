import pytest

from app.config import Settings


def test_cors_origins_are_trimmed_and_limited_to_configured_development_origins():
    settings = Settings(
        _env_file=None,
        cors_allowed_origins=" http://localhost:8081, http://localhost:19006 ",
    )

    assert settings.cors_origins == [
        "http://localhost:8081",
        "http://localhost:19006",
    ]


def test_cors_origins_reject_wildcard_configuration():
    with pytest.raises(ValueError, match="wildcard CORS origins are not allowed"):
        Settings(_env_file=None, cors_allowed_origins="*")


def test_edge_gap_threshold_defaults_and_inclusive_limits():
    settings = Settings(_env_file=None)
    assert settings.max_edge_gap_fraction == 0.5
    assert Settings(_env_file=None, min_gap_fraction=0.2,
                    max_edge_gap_fraction=0.2).max_edge_gap_fraction == 0.2
    assert Settings(_env_file=None, max_edge_gap_fraction=1).max_edge_gap_fraction == 1


@pytest.mark.parametrize("values", [
    {"min_gap_fraction": 0}, {"min_gap_fraction": -0.1},
    {"min_gap_fraction": 1.1}, {"min_gap_fraction": float("nan")},
    {"max_edge_gap_fraction": 0.1}, {"max_edge_gap_fraction": 1.1},
    {"max_edge_gap_fraction": float("inf")},
    {"max_edge_gap_fraction": float("nan")},
    {"min_gap_fraction": 0.6, "max_edge_gap_fraction": 0.5},
])
def test_gap_thresholds_reject_invalid_ranges_and_order(values):
    with pytest.raises(ValueError):
        Settings(_env_file=None, **values)
