import pytest

import app.config as config
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


def test_cpu_defaults_survive_cors_configuration_merge(monkeypatch):
    monkeypatch.setattr(config, "HAS_GPU", False)
    monkeypatch.setattr(config, "HAS_CUDA", False)
    settings = Settings(
        _env_file=None,
        cors_allowed_origins="https://app.example.test",
        seg_model_path="",
        yolo_imgsz=0,
        depth_every_n=0,
        sign_every_n=0,
        depth_enabled=None,
    )

    settings.apply_device_defaults()

    assert settings.cors_origins == ["https://app.example.test"]
    assert settings.seg_model_path == "yolov8s-seg.pt"
    assert settings.yolo_imgsz == 480
    assert settings.depth_every_n == 3
    assert settings.sign_every_n == 3
    assert settings.depth_enabled is False
