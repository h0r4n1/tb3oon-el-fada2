import json
import pathlib
from collections import Counter
DATA = pathlib.Path(__file__).resolve().parent.parent / "data"


for name in ["rover_path.geojson", "waypoints_slims.geojson"]:
    gj = json.loads((DATA / name).read_text(encoding="utf-8"))
    feature = gj["features"]
    types = Counter(f["geometry"]["type"] for f in feature)
    print(f"\n{name}: {len(feature)} features, types={dict(types)}")

    g = feature[0]["geometry"]
    coords = g["coordinates"]
    probe = coords
    depth = 0



    while isinstance(probe[0], list):
        probe = probe[0]
        depth += 1
    print(f"  nesting depth {depth}, first coordinate: {probe} ({len(probe)} values)")





    dimensions = Counter()
    def walk(c):
        if isinstance(c[0], list):
            for sub in c:
                walk(sub)
        else:
            dimensions[len(c)] += 1
    for i in feature:
        walk(i["geometry"]["coordinates"])
    print(f"  coordinate dimensions across all features: {dict(dimensions)}")