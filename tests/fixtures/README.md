# Export fixture

`h264-2s.mp4` is a generated two-second FFmpeg `testsrc2` pattern: 320×180, 10 fps, H.264 baseline, no audio or B-frames. It contains no user recording.

```sh
ffmpeg -f lavfi -i 'testsrc2=size=320x180:rate=10:duration=2' -c:v libx264 -profile:v baseline -bf 0 -g 20 -pix_fmt yuv420p -an -movflags +faststart h264-2s.mp4
```

The export integration test remuxes two copies through the application exporter and checks all 40 packet timestamps plus every PCM sample of a separate WAV track. To retain output files for an independent decoder, set `LOCALTAKE_EXPORT_VALIDATION_DIR` to an absolute scratch directory before running the test.
