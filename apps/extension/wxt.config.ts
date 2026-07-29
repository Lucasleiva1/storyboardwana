import { defineConfig } from "wxt";
import { readFileSync } from "node:fs";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const developmentPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtZfNKvhr4uwpJgCigohAj8eCdpBKkrqJY/HK1ZbejrUxPF8IO8EteWYb27WbOnw2vqZYmOj0cLaZ8nhD1agqJTxoFNOyK7Rz23j0cerGJ2esTE/4Zkd4JLkFI7pGhklsSNswMEly+gn2JXGUOe6o0WpfpsSLHGr+EPJZw3CD7WW3FORe+kSZ8JSY7fZrXjGITXbXLOqjm601REV2kFelyOPpqNaR7JT5uoaaIngCPHOSVUYHwEyOk8f2TmrYtCV2NFa1q8XoRb/sjSwXamFWklC5QGVWLYPv6sDctDwL1yq4jqQfDw4WdvKVDVB8ZXiiWgRBG661ng3XLtPupeDjHwIDAQAB";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "FrameSync Capture",
    description:
      "Captura conversaciones e imágenes y las entrega localmente a FrameSync.",
    version: packageVersion,
    key: developmentPublicKey,
    permissions: [
      "activeTab",
      "nativeMessaging",
      "scripting",
      "sidePanel",
      "storage",
    ],
    host_permissions: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://*.openai.com/*",
      "https://*.oaistatic.com/*",
    ],
    action: {
      default_title: "Abrir FrameSync Capture",
      default_icon: {
        "16": "icon16.png",
        "32": "icon32.png",
        "48": "icon48.png",
        "128": "icon128.png",
      },
    },
    icons: {
      "16": "icon16.png",
      "32": "icon32.png",
      "48": "icon48.png",
      "128": "icon128.png",
    },
  },
});
