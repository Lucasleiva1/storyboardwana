# Native Messaging protocol

Host name: `com.framesync.capture`

Every message is UTF-8 JSON prefixed by an unsigned 32-bit little-endian byte
length. The protocol version is `1`. The host writes protocol frames only to
stdout and diagnostics only to stderr.

The extension keeps a single `chrome.runtime.connectNative` port open for the
entire transaction:

1. `ping`
2. `capture.begin`
3. zero or more `asset.begin`
4. ordered `asset.chunk` messages
5. `asset.end`
6. `capture.commit`

Assets are not embedded in the capture JSON. Chunks are base64, ordered and
verified against the manifest byte count and SHA-256 before rename. A capture
is importable only after `commit.json` exists and the `.partial` directory was
atomically renamed.

Chromium limits host responses to 1 MiB. FrameSync responses contain only an ACK,
error code and small progress metadata. The host accepts at most 64 MiB per
incoming native message and at most 250 MiB per asset in this MVP.

Registration on Windows is per user:

`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.framesync.capture`

The same manifest is also registered under
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.framesync.capture` for
Chrome compatibility.

The default value is the absolute path to the generated host manifest. The
manifest contains one exact `allowed_origins` entry and never a wildcard.
