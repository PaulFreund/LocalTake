declare class MediaStreamTrackProcessor {
  constructor(options: { track: MediaStreamTrack; maxBufferSize?: number });
  readable: ReadableStream<VideoFrame>;
}
interface MediaTrackConstraints {
  resizeMode?: string | ConstrainDOMString;
}
