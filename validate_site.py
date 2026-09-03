"""Fail closed when the static Pages artifact or reduced data schema drifts."""

from __future__ import annotations

import argparse
import json
import re
from collections.abc import Iterable, Sequence
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REQUIRED_FILES = ("index.html", "styles.css", "app.js", "favicon.svg", "data/stats.json")
TOP_LEVEL_KEYS = {
    "schemaVersion",
    "generatedAt",
    "timezoneLabel",
    "currency",
    "businesses",
    "sourceStatus",
    "days",
}
DAY_KEYS = {"date", "isPartial", "profits", "profitSamples", "online"}
BUSINESS_IDS = {"gas", "barbershop"}
BUSINESS_LABELS = {"gas": "АЗС №6", "barbershop": "Барбершоп №5"}
FORBIDDEN_DATA_KEYS = {
    "account",
    "account_balance",
    "balance",
    "cash",
    "cashbox",
    "cookie",
    "credential",
    "login",
    "password",
    "private_key",
    "spreadsheet_id",
    "stock",
    "token",
    "worksheet",
}
MAX_DATA_BYTES = 512_000
MAX_FUTURE_SKEW = timedelta(minutes=10)
SOURCE_TIMEZONE = timezone(timedelta(hours=3))


class SiteValidationError(RuntimeError):
    """Raised when the public Pages artifact violates the release contract."""


def _walk_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key).casefold()
            yield from _walk_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_keys(child)


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_optional_integer(value: Any) -> bool:
    return value is None or _is_integer(value)


def validate_payload(
    payload: dict[str, Any],
    *,
    now: datetime | None = None,
) -> None:
    checked_at = now or datetime.now(timezone.utc)
    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    checked_at = checked_at.astimezone(timezone.utc)
    latest_allowed_at = checked_at + MAX_FUTURE_SKEW
    latest_allowed_day = latest_allowed_at.astimezone(SOURCE_TIMEZONE).date()
    if set(payload) != TOP_LEVEL_KEYS:
        raise SiteValidationError("Dashboard payload top-level keys changed")
    if not _is_integer(payload.get("schemaVersion")) or payload["schemaVersion"] != 1:
        raise SiteValidationError("Dashboard payload schema version changed")
    try:
        generated_at = datetime.fromisoformat(
            str(payload["generatedAt"]).replace("Z", "+00:00")
        )
    except ValueError as error:
        raise SiteValidationError("Dashboard generation timestamp is invalid") from error
    if generated_at.tzinfo is None:
        raise SiteValidationError("Dashboard generation timestamp must include a timezone")
    if generated_at.astimezone(timezone.utc) > latest_allowed_at:
        raise SiteValidationError("Dashboard generation timestamp is in the future")
    if payload.get("timezoneLabel") != "Europe/Moscow (UTC+3)":
        raise SiteValidationError("Dashboard timezone contract changed")
    if payload.get("currency") != "$":
        raise SiteValidationError("Dashboard currency contract changed")

    businesses = payload.get("businesses")
    expected_businesses = [
        {"id": "gas", "label": BUSINESS_LABELS["gas"]},
        {"id": "barbershop", "label": BUSINESS_LABELS["barbershop"]},
    ]
    if businesses != expected_businesses:
        raise SiteValidationError("Dashboard business allowlist changed")

    source_status = payload.get("sourceStatus")
    if not isinstance(source_status, dict) or set(source_status) != BUSINESS_IDS:
        raise SiteValidationError("Dashboard source status is incomplete")
    for status in source_status.values():
        if not isinstance(status, dict) or set(status) != {
            "observations",
            "profitSamples",
            "lastObservedAt",
        }:
            raise SiteValidationError("Dashboard source status keys changed")
        for count_key in ("observations", "profitSamples"):
            if not _is_integer(status[count_key]) or status[count_key] < 0:
                raise SiteValidationError("Dashboard source counts are invalid")
        last_observed_at = status["lastObservedAt"]
        if last_observed_at is not None:
            try:
                parsed_observation = datetime.fromisoformat(
                    str(last_observed_at).replace("Z", "+00:00")
                )
            except ValueError as error:
                raise SiteValidationError("Dashboard source timestamp is invalid") from error
            if parsed_observation.tzinfo is None:
                raise SiteValidationError("Dashboard source timestamp must include a timezone")
            if parsed_observation.astimezone(timezone.utc) > latest_allowed_at:
                raise SiteValidationError("Dashboard source timestamp is in the future")

    days = payload.get("days")
    if not isinstance(days, list) or len(days) > 366:
        raise SiteValidationError("Dashboard day history is invalid")
    previous_date = ""
    for day in days:
        if not isinstance(day, dict) or set(day) != DAY_KEYS:
            raise SiteValidationError("Dashboard day keys changed")
        date_value = day.get("date")
        if not isinstance(date_value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
            raise SiteValidationError("Dashboard day date is invalid")
        try:
            parsed_day = date.fromisoformat(date_value)
        except ValueError as error:
            raise SiteValidationError("Dashboard day date is invalid") from error
        if parsed_day > latest_allowed_day:
            raise SiteValidationError("Dashboard day date is in the future")
        if previous_date and date_value <= previous_date:
            raise SiteValidationError("Dashboard day history must be strictly ascending")
        previous_date = date_value
        if not isinstance(day.get("isPartial"), bool):
            raise SiteValidationError("Dashboard partial-day marker is invalid")
        profits = day.get("profits")
        profit_samples = day.get("profitSamples")
        online = day.get("online")
        if not isinstance(profits, dict) or set(profits) != BUSINESS_IDS:
            raise SiteValidationError("Dashboard profit series changed")
        if not all(_is_optional_integer(value) for value in profits.values()):
            raise SiteValidationError("Dashboard profit values must be integers or null")
        if any(
            value is not None and abs(value) > 1_000_000_000_000
            for value in profits.values()
        ):
            raise SiteValidationError("Dashboard profit value exceeds the safe bound")
        if not isinstance(profit_samples, dict) or set(profit_samples) != BUSINESS_IDS:
            raise SiteValidationError("Dashboard profit sample series changed")
        if not all(_is_integer(value) and value >= 0 for value in profit_samples.values()):
            raise SiteValidationError("Dashboard profit sample counts are invalid")
        if not isinstance(online, dict) or set(online) != {"min", "max", "samples"}:
            raise SiteValidationError("Dashboard online series changed")
        if not _is_optional_integer(online["min"]) or not _is_optional_integer(online["max"]):
            raise SiteValidationError("Dashboard online range is invalid")
        if not _is_integer(online["samples"]) or online["samples"] < 0:
            raise SiteValidationError("Dashboard online sample count is invalid")
        if (
            online["min"] is not None
            and online["max"] is not None
            and (online["min"] < 0 or online["max"] < online["min"] or online["max"] > 100_000)
        ):
            raise SiteValidationError("Dashboard online range is outside safe bounds")

    forbidden_found = set(_walk_keys(payload)) & FORBIDDEN_DATA_KEYS
    if forbidden_found:
        raise SiteValidationError(
            "Dashboard payload contains forbidden raw keys: " + ", ".join(sorted(forbidden_found))
        )


def validate_site(site_directory: Path) -> dict[str, int]:
    if site_directory.is_symlink() or not site_directory.is_dir():
        raise SiteValidationError("Pages site root must be a real directory")

    actual_files: set[str] = set()
    for path in site_directory.rglob("*"):
        relative_path = path.relative_to(site_directory).as_posix()
        if path.is_symlink():
            raise SiteValidationError(f"Pages artifact must not contain symlinks: {relative_path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise SiteValidationError(
                f"Pages artifact must contain only regular files: {relative_path}"
            )
        actual_files.add(relative_path)

    expected_files = set(REQUIRED_FILES)
    if actual_files != expected_files:
        unexpected = sorted(actual_files - expected_files)
        missing = sorted(expected_files - actual_files)
        details = []
        if unexpected:
            details.append("unexpected=" + ",".join(unexpected))
        if missing:
            details.append("missing=" + ",".join(missing))
        raise SiteValidationError(
            "Pages artifact path allowlist changed: " + "; ".join(details)
        )

    for relative_path in REQUIRED_FILES:
        path = site_directory / relative_path
        if not path.is_file() or path.stat().st_size == 0:
            raise SiteValidationError(f"Required Pages file is missing: {relative_path}")

    html = (site_directory / "index.html").read_text(encoding="utf-8")
    css = (site_directory / "styles.css").read_text(encoding="utf-8")
    javascript = (site_directory / "app.js").read_text(encoding="utf-8")
    required_html_fragments = (
        '<html lang="ru">',
        'name="viewport"',
        "Content-Security-Policy",
        '<main>',
        'id="gas-profit-chart"',
        'id="barbershop-profit-chart"',
        'id="online-chart"',
        'id="global-message"',
        '<link rel="stylesheet" href="./styles.css?v=20260903">',
        '<script src="./app.js?v=20260903" defer></script>',
    )
    if any(fragment not in html for fragment in required_html_fragments):
        raise SiteValidationError("Pages HTML accessibility or security contract changed")
    if "@media (prefers-reduced-motion: reduce)" not in css:
        raise SiteValidationError("Pages CSS must preserve reduced-motion behavior")
    if ".profit-bar:focus-visible" not in css or ".online-point:focus-visible" not in css:
        raise SiteValidationError("Pages charts must preserve visible keyboard focus")
    runtime_text = (html + css + javascript).replace("http://www.w3.org/2000/svg", "")
    if re.search(r"https?://", runtime_text, flags=re.IGNORECASE):
        raise SiteValidationError("Pages runtime must not depend on a third-party origin")
    if javascript.count("fetch(") != 1 or "innerHTML" in javascript:
        raise SiteValidationError("Pages JavaScript fetch/DOM safety contract changed")

    data_path = site_directory / "data" / "stats.json"
    if data_path.stat().st_size > MAX_DATA_BYTES:
        raise SiteValidationError("Dashboard aggregate is unexpectedly large")
    try:
        payload = json.loads(data_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SiteValidationError("Dashboard aggregate JSON is invalid") from error
    if not isinstance(payload, dict):
        raise SiteValidationError("Dashboard aggregate must be an object")
    validate_payload(payload)
    return {
        "day_count": len(payload["days"]),
        "data_bytes": data_path.stat().st_size,
        "file_count": len(actual_files),
    }


def parse_args(arguments: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site_directory", type=Path)
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> int:
    args = parse_args(arguments)
    try:
        result = validate_site(args.site_directory)
    except SiteValidationError as error:
        print(f"Pages validation failed: {error}")
        return 1
    print(
        "Pages validation passed: "
        f"{result['file_count']} files, {result['day_count']} day(s), "
        f"{result['data_bytes']} aggregate bytes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
