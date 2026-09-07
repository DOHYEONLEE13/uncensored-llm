/** Only the official, credential-free UTIC player may be embedded. */
export function isUticPlayerUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'www.utic.go.kr' && !url.port &&
      !url.username && !url.password && url.pathname === '/jsp/map/openDataCctvStream.jsp' &&
      [...url.searchParams.keys()].every((key) => ['cctvid', 'cctvname', 'kind'].includes(key.toLowerCase())) &&
      Boolean(url.searchParams.get('cctvid'))
  } catch { return false }
}
