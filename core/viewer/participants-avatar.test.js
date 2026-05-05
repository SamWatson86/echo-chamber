const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeAvatarElement(initials = "Z") {
  let img = null;
  const textNode = {
    nodeType: 3,
    textContent: initials,
    remove() {
      const index = avatar.childNodes.indexOf(textNode);
      if (index >= 0) avatar.childNodes.splice(index, 1);
    },
  };
  const avatar = {
    childNodes: [textNode],
    appendChild(element) {
      if (element.className === "avatar-img") img = element;
      this.childNodes.push(element);
      return element;
    },
    querySelector(selector) {
      if (selector === "video") return null;
      if (selector === "img.avatar-img") return img;
      if (selector === 'input[type="file"]') return null;
      return null;
    },
    get image() {
      return img;
    },
  };
  return avatar;
}

function loadParticipantsAvatar({ deviceId } = {}) {
  const avatar = makeAvatarElement();
  const card = {
    dataset: { identity: "z-6826" },
    querySelector(selector) {
      if (selector === ".user-name") return { textContent: "Z" };
      return null;
    },
  };
  const context = {
    participantCards: new Map([
      ["z-6826", { avatar, card, isLocal: false }],
    ]),
    avatarUrls: new Map(),
    deviceIdByIdentity: new Map(deviceId ? [["z", deviceId]] : []),
    document: {
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          className: "",
          alt: "",
          src: "",
          onerror: null,
        };
      },
    },
    apiUrl(pathname) {
      return "https://echo.example.test:9443" + pathname;
    },
    getIdentityBase(identity) {
      return identity ? identity.replace(/-\d+$/, "") : identity;
    },
    slugifyIdentity(text) {
      return (text || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    },
    debugLog() {},
    console,
  };
  context.global = context;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "participants-avatar.js"), "utf8");
  vm.runInContext(code, context, { filename: "participants-avatar.js" });
  return { context, avatar };
}

test("remote avatar falls back to the server identity avatar when no broadcast URL arrived", () => {
  const { context, avatar } = loadParticipantsAvatar();

  context.updateAvatarDisplay("z-6826");

  assert.equal(avatar.image?.src, "https://echo.example.test:9443/api/avatar/z");
});

test("remote avatar prefers the mapped device avatar once the device id is known", () => {
  const { context, avatar } = loadParticipantsAvatar({
    deviceId: "70ff47ce-0128-4d5f-a29d",
  });

  context.updateAvatarDisplay("z-6826");

  assert.equal(
    avatar.image?.src,
    "https://echo.example.test:9443/api/avatar/70ff47ce-0128-4d5f-a29d"
  );
});
