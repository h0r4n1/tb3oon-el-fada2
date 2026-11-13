"""Produce 2D map layers in data/map-layers/, preserving elevation as properties."""
import json
import pathlib

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
LAYERS = DATA / "map-layers"
LAYERS.mkdir(exist_ok=True)


def strip_z_linestring(feature):
    coords = feature["geometry"]["coordinates"]
    props = dict(feature["properties"])
    props["elevations"] = [c[2] if len(c) > 2 else None for c in coords]
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": [[c[0], c[1]] for c in coords]},
        "properties": props,
    }


def strip_z_point(feature):
    c = feature["geometry"]["coordinates"]
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [c[0], c[1]]},
        "properties": feature["properties"],
    }


for src, dst, fn in [
    ("rover_path.geojson", "rover_path_2d.geojson", strip_z_linestring),
    ("waypoints_slims.geojson", "waypoints_2d.geojson", strip_z_point),
]:
    gj = json.loads((DATA / src).read_text(encoding="utf-8"))
    out = {"type": "FeatureCollection", "features": [fn(f) for f in gj["features"]]}
    path = LAYERS / dst
    path.write_text(json.dumps(out), encoding="utf-8")

    sample = out["features"][0]["geometry"]["coordinates"]
    first = sample[0] if isinstance(sample[0], list) else sample
    assert len(first) == 2, dst + " still has 3D coordinates"
    print("map-layers/" + dst + ": " + str(len(out["features"])) + " features, first coord "
          + str(first) + ", " + str(round(path.stat().st_size / 1024)) + " kB")
