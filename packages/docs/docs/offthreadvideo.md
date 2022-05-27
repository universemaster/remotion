---
id: offthreadvideo
title: "<OffthreadVideo />"
---

_Available from Remotion 3.0.11_

This component imports and displays a video, similar to [`<Video/>`](/docs/video), but during rendering, extracts the exact frame from the video and displays it in a `<Img>` tag. This extraction process happens outside the browser using FFMPEG.

This component was designed to combat limitations of the default `<Video>` element. See: [`<Video>` vs `<OffthreadVideo>`](/docs/video-vs-offthreadvideo).

## Example

```tsx twoslash
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

export const MyVideo = () => {
  const video = staticFile("./video.webm");

  return (
    <AbsoluteFill>
      <OffthreadVideo src={video} />
    </AbsoluteFill>
  );
};
```

:::note
You can also pass a URL as a `src` to load a video remotely.
:::

## API

The props `volume`, `playbackRate` and `muted` are supported and work the same as in [`<Video>`](/docs/video).

The props `onError`, `className` and `style` are supported and get passed to the underlying HTML element. Remember that during render, this is a `<img>` element, and during preview, this is a `<video>` element.

## Performance tips

Avoid embedding a video beyond it's end (for example: Rendering a 5 second video inside 10 second composition). To create parity with the `<Video>` element, the video still display it's last frame in that case. However, to fetch the last frame specifically is a significantly more expensive operation than a frame from a known timestamp.

## See also

- [`<Video />`](/docs/video)
- [`<Video>` vs `<OffthreadVideo>`](/docs/video-vs-offthreadvideo)
