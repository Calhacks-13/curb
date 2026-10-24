#!/usr/bin/env python3

import json
import sys
from pathlib import Path


def main() -> None:
    template_path = Path(sys.argv[1])
    template = json.loads(template_path.read_text())
    container_apps = template["resources"]["containerApps"]
    module_parameters = container_apps["properties"]["parameters"]
    nested_template = container_apps["properties"]["template"]

    assert "managedEnvironmentDefaultDomain" in module_parameters, (
        "the Container Apps module must receive the managed environment domain "
        "from the typed parent resource"
    )

    nested_text = json.dumps(nested_template)
    assert ".properties.defaultDomain" not in nested_text, (
        "ARM reference() already returns a resource's properties by default"
    )

    nested_resources = nested_template["resources"]
    if isinstance(nested_resources, dict):
        api = nested_resources["api"]
    else:
        api = next(
            resource
            for resource in nested_resources
            if resource.get("properties", {})
            .get("configuration", {})
            .get("ingress", {})
            .get("targetPort")
            == 8000
        )
    assert api["properties"]["template"]["scale"]["maxReplicas"] == 1, (
        "the API stores live sessions in memory and must not scale beyond one replica"
    )

    print("test: compiled template uses a valid environment domain and safe API scale")


if __name__ == "__main__":
    main()
