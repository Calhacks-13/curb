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
