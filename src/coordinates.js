
export function isInsideRegion(point, region) {
  if (!point || !region?.bounds) return false;

  const { lat, lon } = point;
  const { south, west, north, east } = region.bounds;

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(south) ||
    !Number.isFinite(west) ||
    !Number.isFinite(north) ||
    !Number.isFinite(east)
  ) {
    return false;
  }

  if (
    south > north ||
    west > east ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon >= 180
  ) {
    return false;
  }

  return (
    lat >= south &&
    lat <= north &&
    lon >= west &&
    lon <= east
  );
}

// GeoJSON: [longitude, latitude]
// Leaflet: [latitude, longitude]
export function geoJsonToLeaflet(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("Invalid GeoJSON coordinate.");
  }

  const [lon, lat] = coordinates;

  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon >= 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new Error("Invalid coordinate values.");
  }

  return [lat, lon];
}
