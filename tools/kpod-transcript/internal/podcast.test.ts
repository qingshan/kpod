import assert from "node:assert/strict";
import test from "node:test";
import { feed, savedPodcastFeed, videoId } from "./podcast.ts";
import { appleEpisodeMetadata, pageMetadata, podcastPageId, podcastPageUrl } from "./podcast-process.ts";

test("single YouTube video URLs are normalized and other inputs rejected", () => {
  assert.equal(videoId("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3"), "jNQXAC9IVRw");
  assert.equal(videoId("https://youtu.be/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(videoId("https://youtube.com.evil.test/watch?v=jNQXAC9IVRw"), null);
  assert.equal(videoId("https://www.youtube.com/playlist?list=PL123"), null);
  assert.equal(videoId("http://www.youtube.com/watch?v=jNQXAC9IVRw"), null);
});

test("RSS episode contains playable enclosure and kpod transcript link", () => {
  const origin = "https://kpod.qingshan.dev/youtube/private";
  const rss = feed([{ id: "jNQXAC9IVRw", title: "A & B <test>", description: "Video & audio", duration: 19,
    bytes: 1000, published: Date.UTC(2026, 9, 10), source: "https://www.youtube.com/watch?v=jNQXAC9IVRw", uploader: "Me" }], origin);
  assert.match(rss, /<title>A &amp; B &lt;test&gt;<\/title>/);
  assert.match(rss, /<enclosure url="https:\/\/kpod.qingshan.dev\/youtube\/private\/media\/jNQXAC9IVRw.mp3" length="1000" type="audio\/mpeg"\/>/);
  assert.match(rss, /<podcast:transcript url="https:\/\/kpod.qingshan.dev\/youtube\/private\/transcripts\/jNQXAC9IVRw.vtt" type="text\/vtt"\/>/);
  assert.match(rss, /<itunes:duration>19<\/itunes:duration>/);
});

test("podcast episode pages keep a stable ID and extract page metadata", () => {
  const url = podcastPageUrl("https://podcasts.example/episodes/one#player");
  assert.equal(url, "https://podcasts.example/episodes/one");
  assert.match(podcastPageId(url!), /^[a-f0-9]{24}$/);
  assert.equal(podcastPageUrl("http://podcasts.example/episodes/one"), null);
  assert.equal(podcastPageUrl("https://127.0.0.1/episode"), null);
  assert.equal(podcastPageUrl("https://podcasts.apple.com/us/podcast/show/id123"), null);
  const page = pageMetadata(`<meta content="A &amp; B" property="og:title">
    <meta name="description" content="A conversation about podcasts">
    <meta property="og:site_name" content="Example Show">
    <meta property="og:audio" content="https://cdn.example/one.mp3">`);
  assert.deepEqual(page, { title: "A & B", description: "A conversation about podcasts",
    show: "Example Show", audio: "https://cdn.example/one.mp3" });
});

test("Apple episode metadata preserves the episode and show names", () => {
  const html = `<script id="serialized-server-data">[{"episodeOffer":{"contentId":"42",
    "title":"Episode title","duration":123,"streamUrl":"https://cdn.example/episode.mp3",
    "showOffer":{"title":"Actual show"}}}]</script>`;
  assert.deepEqual(appleEpisodeMetadata(html, "42"), { title: "Episode title", show: "Actual show",
    duration: 123, audio: "https://cdn.example/episode.mp3" });
  assert.equal(appleEpisodeMetadata(html, "43"), null);
});

test("submitted podcast RSS publishes prepared audio and transcript", () => {
  const rss = savedPodcastFeed([{ id: "a".repeat(24), title: "A & B", description: "Podcast episode",
    show: "Example Show", duration: 77, bytes: 1234, published: Date.UTC(2026, 9, 11),
    source: "https://podcasts.example/episodes/one", uploader: "" }], "https://kpod.example/private");
  assert.match(rss, /<title>My Podcast Episodes<\/title>/);
  assert.match(rss, /<itunes:author>Example Show<\/itunes:author>/);
  assert.match(rss, /<enclosure url="https:\/\/kpod.example\/private\/podcast\/media\/a{24}\.mp3"/);
  assert.match(rss, /<podcast:transcript url="https:\/\/kpod.example\/private\/podcast\/transcripts\/a{24}\.vtt"/);
});
