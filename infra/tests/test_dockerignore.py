#!/usr/bin/env python3

from fnmatch import fnmatchcase
from pathlib import Path


def ignored(path: str, patterns: list[str]) -> bool:
    result = False
    for raw_pattern in patterns:
        pattern = raw_pattern.strip()
        if not pattern or pattern.startswith("#"):
            continue
        negated = pattern.startswith("!")
        if negated:
            pattern = pattern[1:]
        if fnmatchcase(path, pattern):
            result = not negated
    return result


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    patterns = (repo_root / ".dockerignore").read_text().splitlines()

    for secret_path in (".env", ".env.local", "payments/.env", "payments/.env.local"):
        assert ignored(secret_path, patterns), f"{secret_path} would enter the ACR build context"

    for example_path in (".env.example", "payments/.env.example"):
        assert not ignored(example_path, patterns), f"{example_path} should remain available as documentation"

    print("test: root Docker context excludes nested environment secrets")


if __name__ == "__main__":
    main()
