/** Marker emitted by the agent for a value that the renderer may reveal locally. */
const SECRET_MARKER_PATTERN = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export type SecretMarker = {
  alias: string;
  marker: string;
};

/** Extracts each secret alias once while preserving its first-occurrence order. */
export const getSecretMarkers = (content: string): SecretMarker[] => {
  const markers: SecretMarker[] = [];
  const aliases = new Set<string>();

  for (const match of content.matchAll(SECRET_MARKER_PATTERN)) {
    const alias = match[1];
    if (aliases.has(alias)) continue;
    aliases.add(alias);
    markers.push({ alias, marker: match[0] });
  }

  return markers;
};

/**
 * Replaces only markers explicitly resolved by the local user. Unresolved
 * markers remain opaque so they can safely stay in persisted chat content.
 */
export const renderSecretMarkers = (
  content: string,
  values: Readonly<Record<string, string>>,
  unavailable: ReadonlySet<string>,
  unavailableLabel: (alias: string) => string
): string =>
  content.replace(SECRET_MARKER_PATTERN, (marker, alias: string) => {
    if (Object.prototype.hasOwnProperty.call(values, alias)) return values[alias];
    if (unavailable.has(alias)) return unavailableLabel(alias);
    return marker;
  });
