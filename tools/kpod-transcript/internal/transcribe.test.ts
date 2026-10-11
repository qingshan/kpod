import assert from "node:assert/strict";
import test from "node:test";
import { appleStreamFromHtml, sentenceVtt } from "./transcribe.ts";

test("Apple page selects a downloadable audio file", () => {
  const html = '<script id="serialized-server-data">[{"streamUrl":"https://x.test/live.m3u8","other":{"streamUrl":"https://x.test/show.mp3"}}]</script>';
  assert.equal(appleStreamFromHtml(html), "https://x.test/show.mp3");
});

test("short whisper cues join through sentence punctuation", () => {
  const raw = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\nworld.\n\n00:00:02.000 --> 00:00:03.000\nNext one.\n";
  const output = sentenceVtt(raw);
  assert.match(output, /00:00:00.000 --> 00:00:02.000\nHello world\./);
  assert.match(output, /00:00:02.000 --> 00:00:03.000\nNext one\./);
});
