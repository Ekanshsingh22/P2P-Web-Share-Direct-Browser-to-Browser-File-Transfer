# Mars P2P Share — Direct Browser-to-Browser File Transfer

A lightweight, decentralized, and highly secure peer-to-peer (P2P) file sharing web application. Built using **React.js**, **Node.js + Socket.io (Signaling)**, **raw WebRTC**, and **Web Crypto API**.

This platform allows users to drag-and-drop a file to generate an end-to-end encrypted sharing link. The recipient connects directly to the sender's browser to download and stream the file. The central signaling server coordinates the connection handshake but never reads, processes, or stores any part of the file data.

---

##  Key Features

###  Core MVP
1. **Share Room Creation**: Drag-and-drop zone to load files and generate a unique, secure Room ID and invite link.
2. **Signaling Handshake**: Node.js + Socket.io backend to coordinate WebRTC offers, answers, and ICE candidate exchanges.
3. **Direct P2P Transfer**: Data streaming directly between browsers using the `RTCDataChannel` API.
4. **Basic Chunk Verification**: Real-time SHA-256 cryptographic hashing of each block to guarantee zero corruption.
5. **Progress & Stats Dashboard**: Premium visual UI showing transfer progress percentage, real-time speed (MB/s), estimated time remaining (ETA), and active connection status.
6. **Graceful Disconnect Handling**: Clean recovery and visual notices if either peer closes their tab or loses internet.
7. **Auto-Download**: Immediate chunk reassembly and native file download triggers upon completion.

###  Advanced Features (Brownie Points)
* **Zero-Knowledge Encryption**: Files are encrypted inside the browser using AES-GCM (256-bit symmetric key) before being sent. The decryption key is passed in the URL hash (e.g., `/#/room/{roomId}/{hexKey}`). Because URL hashes are client-side only and never sent to HTTP servers, the signaling server has absolute zero knowledge of the encryption key.
* **Large File Support (>500MB)**: Bypasses standard V8 browser RAM limitations:
  * *Modern Browsers*: Uses the File System Access API (`window.showSaveFilePicker`) to stream decrypted chunks directly to the user's local disk.
  * *Fallbacks*: Stores chunks in `IndexedDB` sequentially to avoid page-crashing memory heap expansion, then streams them out for assembly.
* **Connection Churn Recovery (Auto-Resume)**: The receiver tracks chunk indices in IndexedDB or direct-to-disk write offsets. Upon reconnection, the receiver performs a handshake requesting the sender to resume transmitting starting from the last verified chunk index, preventing 0% restarts.

---

##  Project Structure

```text
mars2webd/
├── server/               # Node.js + Socket.io Signaling Backend
│   ├── package.json
│   └── server.js
├── client/               # React + Vite Frontend Client
│   ├── package.json
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── index.css
│       ├── webrtc.js     # WebRTC, encryption, and custom binary framing
│       └── db.js         # IndexedDB local cache database
└── README.md
```

---

##  Getting Started

###  Prerequisites
Make sure you have [Node.js (LTS)](https://nodejs.org) installed on your machine.

---

### 1. Run the Signaling Backend
Navigate to the `server/` directory, install the dependencies, and start the server:

```bash
cd server
npm install
npm start
```
The signaling server will start on port `5000` (e.g., `http://localhost:5000`).

---

### 2. Run the React Client
Navigate to the `client/` directory, install the dependencies, and start the Vite dev server:

```bash
cd client
npm install
npm run dev
```
The React frontend dev server will launch on port `5173` (e.g., `http://localhost:5173`).

---

##  Technical Implementation Details

### Custom P2P Binary Packet Layout
To ensure metadata transmission, security, and integrity, file data sent over `RTCDataChannel` is packaged into a custom binary layout before sending:
```text
┌─────────────────────────────────────────────────────────────┐
│ Header (36 Bytes)                                           │
├──────────────────────┬──────────────────────────────────────┤
│ Chunk Index (4 B)    │ Chunk original SHA-256 Hash (32 B)   │
├──────────────────────┴──────────────────────────────────────┤
│ Encrypted Payload (Variable)                                │
├─────────────────────────────────────────────────────────────┤
│ AES-GCM IV (12 B)    │ Encrypted Chunk Data                 │
└─────────────────────────────────────────────────────────────┘
```

1. **Chunk Index (4 bytes)**: Allows out-of-order reassembly and resume offsets.
2. **SHA-256 Hash (32 bytes)**: Verified post-decryption to ensure no network corruption.
3. **AES-GCM IV (12 bytes)**: Initialization vector generated uniquely for each chunk.
4. **Encrypted Chunk Data**: Encrypted using the client-side AES key.

---

##  Testing and Verification

To verify the app locally:
1. Open two browser windows side-by-side:
   - Window 1: (https://p2-p-web-share-direct-browser-to-br-orcin.vercel.app/) (Sender)
   - Window 2: (https://p2-p-web-share-direct-browser-to-br-orcin.vercel.app/) (Receiver)
2. In **Window 1**, drag and drop a test file (e.g., a PDF, image, or zip archive).
3. Copy the generated invite link.
4. Paste the link into **Window 2**. The WebRTC handshake will execute instantly.
5. In **Window 2**, if the file is large, click "Choose Local Output Path" to enable direct-to-disk stream writing.
6. The transfer will begin automatically. Monitor the progress, speed, and ETA stats.
7. Upon completion, the file will save to your downloads folder or chosen path. Open it to confirm there is zero corruption!
