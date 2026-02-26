/* =========================================================
   CHAT — Messages, file uploads, emoji picker, and persistence
   ========================================================= */

const EMOJI_LIST = [
  "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇",
  "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲", "😋", "😛", "😜", "🤪", "😝",
  "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄",
  "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🤧",
  "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "🥸", "😎", "🤓", "🧐", "😕", "😟",
  "🙁", "☹️", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢",
  "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬",
  "😈", "👿", "💀", "☠️", "💩", "🤡", "👹", "👺", "👻", "👽", "👾", "🤖", "😺",
  "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "👋", "🤚", "🖐️", "✋", "🖖",
  "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇",
  "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏",
  "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃", "🧠", "🫀",
  "🫁", "🦷", "🦴", "👀", "👁️", "👅", "👄", "💋", "🩸", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🤎", "🖤", "🤍", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘",
  "💝", "💟", "☮️", "✝️", "☪️", "🕉️", "☸️", "✡️", "🔯", "🕎", "☯️", "☦️", "🛐",
  "⛎", "♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓", "🆔", "⚛️",
  "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩",
  "🟦", "🟪", "🟫", "⬛", "⬜", "🔶", "🔷", "🔸", "🔹", "🔺", "🔻", "💠", "🔘",
  "🔳", "🔲", "🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️", "🇺🇳"
];

// Open external links in system browser
document.addEventListener("click", function(e) {
  var link = e.target.closest("a[href]");
  if (!link) return;
  var href = link.getAttribute("href");
  if (!href || !/^https?:\/\//.test(href)) return;
  if (href.startsWith(window.location.origin)) return; // skip internal links
  e.preventDefault();
  debugLog("[link] clicked: " + href);
  if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
    // Tauri client: open on THIS user's machine via IPC
    tauriInvoke("open_external_url", { url: href }).catch(function(err) {
      debugLog("[link] tauriInvoke open_external_url failed: " + err);
    });
  } else {
    // Regular browser: just open in new tab
    window.open(href, "_blank");
  }
});

async function fetchImageAsBlob(url) {
  try {
    // Use LiveKit access token so all room participants can view images
    const token = currentAccessToken || adminToken;
    debugLog(`fetchImageAsBlob: url=${url}, hasCurrentAccessToken=${!!currentAccessToken}, hasAdminToken=${!!adminToken}, usingToken=${token ? 'yes' : 'no'}`);

    if (!token) {
      debugLog(`ERROR: No token available for image fetch!`);
      return null;
    }

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "image/*"
      }
    });

    debugLog(`fetchImageAsBlob: response status=${response.status}, ok=${response.ok}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unable to read error');
      debugLog(`fetchImageAsBlob: server error - ${errorText}`);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    debugLog(`Failed to fetch image: ${err.message}`);
    return null;
  }
}

function renderChatMessage(message) {
  const messageEl = document.createElement("div");
  messageEl.className = "chat-message";
  if (message.id) {
    messageEl.dataset.msgId = message.id;
  }

  const headerEl = document.createElement("div");
  headerEl.className = "chat-message-header";

  const authorEl = document.createElement("div");
  authorEl.className = "chat-message-author";
  if (message.identity === room?.localParticipant?.identity) {
    authorEl.classList.add("self");
  }
  authorEl.textContent = message.name || message.identity;

  const timeEl = document.createElement("div");
  timeEl.className = "chat-message-time";
  timeEl.textContent = formatTime(message.timestamp);

  headerEl.appendChild(authorEl);
  headerEl.appendChild(timeEl);
  messageEl.appendChild(headerEl);

  // Delete button — own messages only
  if (message.identity === room?.localParticipant?.identity && message.id) {
    var deleteBtn = document.createElement("button");
    deleteBtn.className = "chat-message-delete";
    deleteBtn.textContent = "\u00D7";
    deleteBtn.title = "Delete message";
    deleteBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      deleteChatMessage(message);
    });
    messageEl.appendChild(deleteBtn);
  }

  if (message.type === CHAT_FILE_TYPE && message.fileUrl) {
    if (message.fileType?.startsWith("image/")) {
      const imgEl = document.createElement("img");
      imgEl.className = "chat-message-image";
      imgEl.alt = message.fileName || "Image";
      imgEl.loading = "lazy";

      // Resolve relative URLs using current controlUrl
      const imageUrl = message.fileUrl.startsWith('http')
        ? message.fileUrl
        : `${controlUrlInput?.value || 'https://127.0.0.1:9443'}${message.fileUrl}`;

      // Fetch image with auth and create blob URL
      fetchImageAsBlob(imageUrl).then(blobUrl => {
        if (blobUrl) {
          imgEl.src = blobUrl;
        } else {
          imgEl.src = ""; // Show broken image
          imgEl.alt = "Failed to load image";
        }
      });

      imgEl.addEventListener("click", () => {
        // Open full-size image in lightbox overlay
        if (imgEl.src) openImageLightbox(imgEl.src);
      });
      messageEl.appendChild(imgEl);

      if (message.text) {
        const contentEl = document.createElement("div");
        contentEl.className = "chat-message-content";
        contentEl.innerHTML = linkifyText(message.text);
        messageEl.appendChild(contentEl);
      }
    } else if (message.fileType?.startsWith("video/")) {
      // Inline video player with download button
      const videoUrl = message.fileUrl.startsWith('http')
        ? message.fileUrl
        : `${controlUrlInput?.value || 'https://127.0.0.1:9443'}${message.fileUrl}`;
      const videoEl = document.createElement("video");
      videoEl.className = "chat-message-video";
      videoEl.controls = true;
      videoEl.preload = "metadata";
      videoEl.style.maxWidth = "100%";
      videoEl.style.maxHeight = "300px";
      videoEl.style.borderRadius = "var(--radius-sm)";
      // On mobile, show tap-to-load placeholder instead of auto-fetching
      if (_isMobileDevice) {
        videoEl.setAttribute("poster", "");
        const tapOverlay = document.createElement("div");
        tapOverlay.className = "chat-message-file";
        tapOverlay.style.cursor = "pointer";
        tapOverlay.innerHTML = '<div class="chat-message-file-icon">\u25B6\uFE0F</div><div class="chat-message-file-name">Tap to load video: ' + escapeHtml(message.fileName || "Video") + '</div>';
        tapOverlay.addEventListener("click", async () => {
          try {
            const token = currentAccessToken || adminToken;
            const response = await fetch(videoUrl, {
              headers: { "Authorization": `Bearer ${token}`, "Accept": "application/octet-stream" }
            });
            const blob = await response.blob();
            videoEl.src = URL.createObjectURL(blob);
            tapOverlay.replaceWith(videoEl);
          } catch (err) { debugLog(`Failed to load video: ${err.message}`); }
        }, { once: true });
        messageEl.appendChild(tapOverlay);
      } else {
        // Fetch with auth and set blob src
        (async () => {
          try {
            const token = currentAccessToken || adminToken;
            const response = await fetch(videoUrl, {
              headers: { "Authorization": `Bearer ${token}` }
            });
            const blob = await response.blob();
            videoEl.src = URL.createObjectURL(blob);
          } catch (err) {
            debugLog(`Failed to load video: ${err.message}`);
          }
        })();
        messageEl.appendChild(videoEl);
      }

      // Download link below video
      const dlLink = document.createElement("div");
      dlLink.className = "chat-message-file";
      dlLink.style.marginTop = "4px";
      dlLink.style.cursor = "pointer";
      dlLink.innerHTML = '<div class="chat-message-file-icon">💾</div><div class="chat-message-file-name">' + escapeHtml(message.fileName || "Video") + '</div>';
      dlLink.addEventListener("click", async () => {
        try {
          const token = currentAccessToken || adminToken;
          const dlUrl = message.fileUrl.startsWith('http') ? message.fileUrl : apiUrl(message.fileUrl);
          const response = await fetch(dlUrl, { headers: { "Authorization": `Bearer ${token}` } });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = message.fileName || "video.mp4";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          debugLog(`Failed to download video: ${err.message}`);
        }
      });
      messageEl.appendChild(dlLink);
    } else if (message.fileType?.startsWith("audio/")) {
      // Inline audio player
      const audioUrl = message.fileUrl.startsWith('http')
        ? message.fileUrl
        : `${controlUrlInput?.value || 'https://127.0.0.1:9443'}${message.fileUrl}`;
      const audioEl = document.createElement("audio");
      audioEl.className = "chat-message-audio";
      audioEl.controls = true;
      audioEl.preload = "metadata";
      audioEl.style.width = "100%";
      // On mobile, show tap-to-load placeholder instead of auto-fetching
      if (_isMobileDevice) {
        const tapOverlay = document.createElement("div");
        tapOverlay.className = "chat-message-file";
        tapOverlay.style.cursor = "pointer";
        tapOverlay.innerHTML = '<div class="chat-message-file-icon">\uD83C\uDFB5</div><div class="chat-message-file-name">Tap to play: ' + escapeHtml(message.fileName || "Audio") + '</div>';
        tapOverlay.addEventListener("click", async () => {
          try {
            const token = currentAccessToken || adminToken;
            const response = await fetch(audioUrl, {
              headers: { "Authorization": `Bearer ${token}`, "Accept": "application/octet-stream" }
            });
            const blob = await response.blob();
            audioEl.src = URL.createObjectURL(blob);
            tapOverlay.replaceWith(audioEl);
          } catch (err) { debugLog(`Failed to load audio: ${err.message}`); }
        }, { once: true });
        messageEl.appendChild(tapOverlay);
      } else {
        (async () => {
          try {
            const token = currentAccessToken || adminToken;
            const response = await fetch(audioUrl, {
              headers: { "Authorization": `Bearer ${token}` }
            });
            const blob = await response.blob();
            audioEl.src = URL.createObjectURL(blob);
          } catch (err) {
            debugLog(`Failed to load audio: ${err.message}`);
          }
        })();
        messageEl.appendChild(audioEl);
      }
    } else {
      const fileEl = document.createElement("div");
      fileEl.className = "chat-message-file";
      fileEl.addEventListener("click", async () => {
        // Download file with auth
        try {
          const token = currentAccessToken || adminToken;
          const dlUrl = message.fileUrl.startsWith('http') ? message.fileUrl : apiUrl(message.fileUrl);
          const response = await fetch(dlUrl, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = message.fileName || "file";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          debugLog(`Failed to download file: ${err.message}`);
        }
      });

      const iconEl = document.createElement("div");
      iconEl.className = "chat-message-file-icon";
      iconEl.textContent = "📄";

      const nameEl = document.createElement("div");
      nameEl.className = "chat-message-file-name";
      nameEl.textContent = message.fileName || "File";

      fileEl.appendChild(iconEl);
      fileEl.appendChild(nameEl);
      messageEl.appendChild(fileEl);

      if (message.text) {
        const contentEl = document.createElement("div");
        contentEl.className = "chat-message-content";
        contentEl.innerHTML = linkifyText(message.text);
        messageEl.appendChild(contentEl);
      }
    }
  } else if (message.text) {
    const contentEl = document.createElement("div");
    contentEl.className = "chat-message-content";
    contentEl.innerHTML = linkifyText(message.text);
    messageEl.appendChild(contentEl);
  }

  return messageEl;
}

function addChatMessage(message) {
  chatHistory.push(message);
  const messageEl = renderChatMessage(message);
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Persist to server
  saveChatMessage(message);
}

function sendChatMessage(text, fileData = null) {
  if (!room || !room.localParticipant) return;

  const ts = Date.now();
  const message = {
    type: fileData ? CHAT_FILE_TYPE : CHAT_MESSAGE_TYPE,
    identity: room.localParticipant.identity,
    name: room.localParticipant.name || room.localParticipant.identity,
    text: text.trim(),
    timestamp: ts,
    room: currentRoomName,
    id: room.localParticipant.identity + "-" + ts
  };

  if (fileData) {
    message.fileUrl = fileData.url;
    message.fileName = fileData.name;
    message.fileType = fileData.type;
  }

  // Send via LiveKit data channel
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(message));
    room.localParticipant.publishData(data, {reliable: true});
  } catch (err) {
    debugLog(`Failed to send chat message: ${err.message}`);
  }

  // Add to local chat
  addChatMessage(message);
}

function handleIncomingChatData(payload, participant) {
  try {
    const decoder = new TextDecoder();
    const text = decoder.decode(payload);
    const message = JSON.parse(text);

    // Only handle messages for current room
    if (message.room && message.room !== currentRoomName) return;

    // Ignore messages from self (already added locally)
    if (participant && participant.identity === room?.localParticipant?.identity) return;

    if (message.type === CHAT_MESSAGE_TYPE || message.type === CHAT_FILE_TYPE) {
      // Ensure message has required fields
      if (!message.identity) {
        message.identity = participant?.identity || "unknown";
      }
      if (!message.name) {
        message.name = participant?.name || participant?.identity || "Unknown";
      }
      if (!message.timestamp) {
        message.timestamp = Date.now();
      }

      chatHistory.push(message);
      const messageEl = renderChatMessage(message);
      chatMessages.appendChild(messageEl);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Show notification badge if chat is closed
      incrementUnreadChat();
    }
  } catch (err) {
    debugLog(`Failed to parse chat data: ${err.message}`);
  }
}

function updateChatBadge() {
  if (!chatBadge) return;
  if (unreadChatCount > 0) {
    chatBadge.textContent = unreadChatCount > 99 ? "99+" : unreadChatCount;
    chatBadge.classList.remove("hidden");
  } else {
    chatBadge.classList.add("hidden");
  }
}

function incrementUnreadChat() {
  // Only increment if chat is closed
  if (chatPanel && chatPanel.classList.contains("hidden")) {
    unreadChatCount++;
    updateChatBadge();

    // Trigger pulse animation on chat button
    if (openChatButton) {
      openChatButton.classList.remove("has-unread");
      // Force reflow to restart animation
      void openChatButton.offsetWidth;
      openChatButton.classList.add("has-unread");
    }
  }
}

function clearUnreadChat() {
  unreadChatCount = 0;
  updateChatBadge();
  if (openChatButton) {
    openChatButton.classList.remove("has-unread");
  }
}

function openChat() {
  if (!chatPanel) return;
  chatPanel.classList.remove("hidden");
  document.querySelector(".room-layout")?.classList.add("chat-open");
  chatMessages.scrollTop = chatMessages.scrollHeight;
  chatInput.focus();
  clearUnreadChat();
}

function closeChat() {
  if (!chatPanel) return;
  chatPanel.classList.add("hidden");
  document.querySelector(".room-layout")?.classList.remove("chat-open");
}

function initializeEmojiPicker() {
  if (!chatEmojiPicker) return;
  chatEmojiPicker.innerHTML = "";
  EMOJI_LIST.forEach(emoji => {
    const emojiEl = document.createElement("div");
    emojiEl.className = "chat-emoji";
    emojiEl.textContent = emoji;
    emojiEl.addEventListener("click", () => {
      const cursorPos = chatInput.selectionStart;
      const textBefore = chatInput.value.substring(0, cursorPos);
      const textAfter = chatInput.value.substring(cursorPos);
      chatInput.value = textBefore + emoji + textAfter;
      chatInput.focus();
      chatInput.selectionStart = chatInput.selectionEnd = cursorPos + emoji.length;
      chatEmojiPicker.classList.add("hidden");
    });
    chatEmojiPicker.appendChild(emojiEl);
  });
}

function toggleEmojiPicker() {
  if (!chatEmojiPicker) return;
  chatEmojiPicker.classList.toggle("hidden");
}

async function fixImageOrientation(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Set canvas size to image size
        canvas.width = img.width;
        canvas.height = img.height;

        // Draw image onto canvas (this strips EXIF and normalizes orientation)
        ctx.drawImage(img, 0, 0);

        // Convert canvas back to blob
        canvas.toBlob((blob) => {
          resolve(blob || file);
        }, file.type || 'image/png', 0.95);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

async function handleChatImagePaste(file) {
  if (!file) {
    debugLog("No file provided to upload");
    return null;
  }

  if (!adminToken) {
    debugLog("Cannot upload file: Not authenticated (adminToken missing)");
    setStatus("Cannot upload: Not connected", true);
    return null;
  }

  // Fix image orientation if it's an image
  if (file.type.startsWith('image/')) {
    debugLog("Fixing image orientation...");
    file = await fixImageOrientation(file);
  }

  try {
    const controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    debugLog(`Uploading file: ${file.name} (${file.type}, ${file.size} bytes)`);

    const fileBytes = await file.arrayBuffer();
    const response = await fetch(`${controlUrl}/api/chat/upload?room=${encodeURIComponent(currentRoomName)}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`
      },
      body: fileBytes
    });

    debugLog(`Upload response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      debugLog(`Upload failed: ${errorText}`);
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    debugLog(`Upload result: ${JSON.stringify(result)}`);

    if (!result.ok || !result.url) {
      throw new Error(result.error || "Upload failed");
    }

    debugLog(`File uploaded successfully: ${result.url}`);

    // Store relative URL so it works for all users regardless of their control URL
    return {
      url: result.url,  // Store relative path like /api/chat/uploads/filename
      name: file.name,
      type: file.type
    };
  } catch (err) {
    debugLog(`Failed to upload file: ${err.message}`);
    setStatus(`Upload failed: ${err.message}`, true);
    return null;
  }
}

async function handleChatFileUpload() {
  if (!chatFileInput || !chatFileInput.files || chatFileInput.files.length === 0) return;

  const file = chatFileInput.files[0];
  const fileData = await handleChatImagePaste(file);

  if (fileData) {
    sendChatMessage("", fileData);
  }

  chatFileInput.value = "";
}

async function loadChatHistory(roomName) {
  try {
    const controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    const response = await fetch(`${controlUrl}/api/chat/history/${encodeURIComponent(roomName)}`, {
      headers: {
        "Authorization": `Bearer ${adminToken}`
      }
    });

    if (!response.ok) return;

    const history = await response.json();

    // Guard: if user switched rooms while fetch was in-flight, discard stale result
    if (roomName !== currentRoomName) return;

    chatHistory.length = 0;
    chatMessages.innerHTML = "";

    history.forEach(message => {
      chatHistory.push(message);
      const messageEl = renderChatMessage(message);
      chatMessages.appendChild(messageEl);
    });

    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Clear unread count when loading history (user sees all messages)
    clearUnreadChat();
  } catch (err) {
    debugLog(`Failed to load chat history: ${err.message}`);
  }
}

async function saveChatMessage(message) {
  try {
    const controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    await fetch(`${controlUrl}/api/chat/message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message)
    });
  } catch (err) {
    debugLog(`Failed to save chat message: ${err.message}`);
  }
}

async function deleteChatMessage(message) {
  if (!message.id || !room || !room.localParticipant) return;
  if (message.identity !== room.localParticipant.identity) return;
  // Remove from server
  try {
    var controlUrl = controlUrlInput?.value || "https://127.0.0.1:9443";
    await fetch(controlUrl + "/api/chat/delete", {
      method: "POST",
      headers: { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ id: message.id, identity: room.localParticipant.identity, room: currentRoomName })
    });
  } catch (err) {
    debugLog("Failed to delete chat message: " + err.message);
    return;
  }
  // Remove from local history
  var idx = chatHistory.findIndex(function(m) { return m.id === message.id; });
  if (idx !== -1) chatHistory.splice(idx, 1);
  // Remove from DOM
  var msgEl = chatMessages?.querySelector('[data-msg-id="' + CSS.escape(message.id) + '"]');
  if (msgEl) msgEl.remove();
  // Broadcast deletion to other users
  try {
    var encoder = new TextEncoder();
    room.localParticipant.publishData(
      encoder.encode(JSON.stringify({ type: "chat-delete", id: message.id, identity: room.localParticipant.identity, room: currentRoomName })),
      { reliable: true }
    );
  } catch (err) {
    debugLog("Failed to broadcast chat deletion: " + err.message);
  }
}

// Chat event listeners
if (openChatButton) {
  openChatButton.addEventListener("click", () => {
    openChat();
  });
}

if (closeChatButton) {
  closeChatButton.addEventListener("click", () => {
    closeChat();
  });
}

if (chatSendBtn) {
  chatSendBtn.addEventListener("click", () => {
    const text = chatInput.value.trim();
    if (text) {
      sendChatMessage(text);
      chatInput.value = "";
      chatInput.style.height = "auto";
    }
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (text) {
        sendChatMessage(text);
        chatInput.value = "";
        chatInput.style.height = "auto";
      }
    }
  });

  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  chatInput.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const fileData = await handleChatImagePaste(file);
          if (fileData) {
            const text = chatInput.value.trim();
            sendChatMessage(text, fileData);
            chatInput.value = "";
            chatInput.style.height = "auto";
          }
        }
        break;
      }
    }
  });
}

if (chatEmojiBtn) {
  chatEmojiBtn.addEventListener("click", () => {
    toggleEmojiPicker();
  });
}

if (chatUploadBtn) {
  chatUploadBtn.addEventListener("click", () => {
    if (chatFileInput) {
      chatFileInput.click();
    }
  });
}

if (chatFileInput) {
  chatFileInput.addEventListener("change", () => {
    handleChatFileUpload();
  });
}
