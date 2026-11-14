"""The Grafana dashboard and alert rules only reference metrics the code exports, and every
alert is complete (severity, summary)."""

import json
import pathlib
import re

import yaml
from prometheus_client import REGISTRY

import relay_dataplane.observability  # noqa: F401  (registers every metric)

GRAFANA = pathlib.Path(__file__).resolve().parents[2] / "deploy" / "grafana"


SUFFIXES = {"counter": ("_total",), "histogram": ("_bucket", "_count", "_sum"), "gauge": ("",)}


def exported() -> set[str]:
    """Every series name the metric definitions produce (labelled metrics have no samples until used)."""
    return {f.name + suffix for f in REGISTRY.collect() for suffix in SUFFIXES.get(f.type, ("",))}


def referenced(text: str) -> set[str]:
    return set(re.findall(r"\b(relay_[a-z_]+)", text))


def test_dashboard_is_valid_and_uses_only_exported_metrics():
    dashboard = json.loads((GRAFANA / "relay-overview.json").read_text())
    exprs = [t["expr"] for p in dashboard["panels"] for t in p.get("targets", [])]
    assert len(exprs) >= 20
    unknown = set().union(*(referenced(e) for e in exprs)) - exported()
    assert unknown == set()
    assert len({p["id"] for p in dashboard["panels"]}) == len(dashboard["panels"])


def test_alert_rules_are_complete_and_use_only_exported_metrics():
    rules = [r for g in yaml.safe_load((GRAFANA / "relay-alerts.yaml").read_text())["groups"] for r in g["rules"]]
    assert len(rules) >= 10
    for rule in rules:
        assert {"alert", "expr", "labels", "annotations"} <= set(rule), rule.get("alert")
        assert rule["labels"]["severity"] in {"info", "warning", "critical"}
        assert rule["annotations"]["summary"]
        assert referenced(rule["expr"]) - exported() == set(), rule["alert"]
    names = [r["alert"] for r in rules]
    assert len(names) == len(set(names))


def test_retention_lag_alerts_at_twice_the_cleanup_interval():
    from relay_dataplane.settings import Settings

    rules = {
        r["alert"]: r for g in yaml.safe_load((GRAFANA / "relay-alerts.yaml").read_text())["groups"] for r in g["rules"]
    }
    threshold = float(rules["RelayRetentionLagHigh"]["expr"].rsplit(">", 1)[1])
    assert threshold == 2 * Settings("x", "y").retention_interval
