import json
import pathlib

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
wayp = json.loads((DATA / "waypoints_slims.geojson").read_text(encoding="utf-8"))
feats = wayp["features"]

lats = [f["properties"]["lat"] for f in feats if f["properties"]["lat"] is not None]
lons = [f["properties"]["lon"] for f in feats if f["properties"]["lon"] is not None]





landing = min(feats, key=lambda f: f["properties"]["sol"] if f["properties"]["sol"] is not None else 1e9)
lp = landing["properties"]
print(f"landing waypoint: sol {lp['sol']}, lat {lp['lat']}, lon {lp['lon']}")

region = {
    "id": "jezero",
    "name": "Jezero Crater",
    "status": "demo",
    "bounds": {
        "south": min(lats),
        "west": min(lons),
        "north": max(lats),
        "east": max(lons),
    },
    "base": {
        "lat": lp["lat"],
        "lon": lp["lon"],
        "label": "Octavia E. Butler Landing",
        "isFictional": False,
    },
    "sourceIds": ["m20-waypoints", "m20-traverse"],
    "dataVersion": "2026-11-13.1",
}





b = region["bounds"]
assert b["south"] < b["north"] and b["west"] < b["east"], "bounds not ordered"
assert -180 <= b["west"] < 180 and -180 <= b["east"] < 180, "longitude out of range"
assert b["south"] <= region["base"]["lat"] <= b["north"], "base latitude outside bounds"
assert b["west"] <= region["base"]["lon"] <= b["east"], "base longitude outside bounds"

(DATA / "region.json").write_text(json.dumps(region, indent=2), encoding="utf-8")
print(json.dumps(region, indent=2))