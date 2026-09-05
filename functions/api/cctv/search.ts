import { handleNearbyCctvRequest, type CctvPagesContext } from '../../_cctv'

export function onRequest(context: CctvPagesContext) {
  return handleNearbyCctvRequest(context, 'search')
}
