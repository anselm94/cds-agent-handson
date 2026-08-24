import {
  getDestination,
  buildHeadersForDestination,
} from "@sap-cloud-sdk/connectivity";

export async function resolveDestinationUrl(destinationName) {
  const resolvedDest = await getDestination({ destinationName });
  return resolvedDest?.url ?? "";
}

export async function resolveDestinationHeaders(destinationName) {
  try {
    const resolvedDest = await getDestination({ destinationName });
    if (!resolvedDest) return {};

    const rawHeaders = await buildHeadersForDestination(resolvedDest);
    // Cloud SDK returns lowercase header keys (e.g. "authorization") —
    // normalize to title-case so HTTP clients handle them correctly.
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([k, v]) => [
        k.replace(/(^|-)(.)/g, (_, sep, c) => sep + c.toUpperCase()),
        v,
      ]),
    );
    return headers;
  } catch (error) {
    return {};
  }
}
