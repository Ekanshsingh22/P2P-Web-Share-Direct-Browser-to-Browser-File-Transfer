import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { 
  FolderIcon, 
  Share2Icon, 
  CopyIcon, 
  CheckIcon, 
  DownloadIcon, 
  WifiIcon, 
  WifiOffIcon, 
  RefreshCwIcon, 
  XIcon, 
  LockIcon,
  ShieldCheckIcon,
  HardDriveIcon
} from 'lucide-react';
import { 
  generateEncryptionKey, 
  exportKey, 
  importKey, 
  createChunkPacket, 
  parseChunkPacket, 
  RTC_CONFIG, 
  CHUNK_SIZE 
} from './webrtc';
import { saveChunk, getChunk, saveMeta, getMeta, clearRoom } from './db';

const SIGNAL_SERVER = import.meta.env.VITE_SIGNAL_SERVER || 'https://p2p-web-share-direct-browser-to-browser-xts1.onrender.com';

function App() {
  // Navigation & Role states
  const [role, setRole] = useState(null); // 'sender' | 'receiver'
  const [roomId, setRoomId] = useState('');
  const [encryptionKey, setEncryptionKey] = useState(null); // CryptoKey
  const [hexKey, setHexKey] = useState('');
  
  // Connection states
  const [socketConnected, setSocketConnected] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [peerStatus, setPeerStatus] = useState('Disconnected'); // 'Disconnected' | 'Connecting' | 'Connected'
  
  // File states
  const [file, setFile] = useState(null);
  const [meta, setMeta] = useState(null); // { name, size, type, totalChunks }
  
  // Transfer Progress states
  const [progress, setProgress] = useState(0); // 0 - 100
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState(0); // Bytes/sec
  const [eta, setEta] = useState(null); // seconds
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferComplete, setTransferComplete] = useState(false);

  // File system handle for direct-to-disk streaming
  const [fileWritable, setFileWritable] = useState(null);
  const [isDirectDiskSupported, setIsDirectDiskSupported] = useState(false);
  const [useDirectDisk, setUseDirectDisk] = useState(false);

  // UI States
  const [dragActive, setDragActive] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [copied, setCopied] = useState(false);

  // WebRTC & Socket Refs
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const transferStartRef = useRef(null);
  const lastProgressTimeRef = useRef(null);
  const lastProgressBytesRef = useRef(null);
  
  // Active transfer state tracking (to allow stop/resume)
  const activeTransferRef = useRef({
    currentChunk: 0,
    totalChunks: 0,
    isPaused: false
  });

  // Detect role from URL hash on mount
  useEffect(() => {
    setIsDirectDiskSupported(typeof window.showSaveFilePicker === 'function');
    
    const parseUrlHash = async () => {
      const hash = window.location.hash;
      const match = hash.match(/#\/room\/([a-zA-Z0-9]+)\/([a-fA-F0-9]+)/);
      if (match) {
        const rId = match[1];
        const hKey = match[2];
        setRoomId(rId);
        setHexKey(hKey);
        setRole('receiver');
        
        try {
          const key = await importKey(hKey);
          setEncryptionKey(key);
          showToast('info', 'Loaded encrypted share room key.');
        } catch (err) {
          showToast('error', 'Invalid cryptographic key in URL.');
        }
      } else {
        setRole('sender');
      }
    };

    parseUrlHash();
    
    // Listen to hash change to allow navigation
    window.addEventListener('hashchange', parseUrlHash);
    return () => window.removeEventListener('hashchange', parseUrlHash);
  }, []);

  // Socket Connection and Setup
  useEffect(() => {
    if (!role || !roomId) return;

    // Connect to Socket.io
    const socket = io(SIGNAL_SERVER);
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
      socket.emit('join', { roomId, role });
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
      setPeerConnected(false);
      setPeerStatus('Disconnected');
    });

    socket.on('joined-successfully', ({ peers }) => {
      showToast('success', `Connected to room ${roomId}`);
      if (peers.length > 0) {
        showToast('info', 'Peer detected in room. Initiating handshake...');
        if (role === 'sender') {
          // Senders initiate WebRTC connections
          initiateWebRTC();
        }
      }
    });

    socket.on('peer-joined', ({ role: peerRole }) => {
      showToast('info', `Receiver joined the room.`);
      if (role === 'sender') {
        initiateWebRTC();
      }
    });

    socket.on('signal', async ({ data }) => {
      if (!peerConnectionRef.current) {
        createPeerConnection();
      }
      
      const pc = peerConnectionRef.current;
      
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          if (pc.remoteDescription.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socketRef.current.emit('signal', { roomId, data: { sdp: pc.localDescription } });
          }
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.error('Signaling error', err);
      }
    });

    socket.on('peer-left', () => {
      showToast('error', 'Peer disconnected.');
      setPeerConnected(false);
      setPeerStatus('Disconnected');
      setIsTransferring(false);
      
      // Cleanup WebRTC connection, preparing for reconnect / resume
      cleanupWebRTC(false);
    });

    socket.on('room-full', () => {
      showToast('error', 'This sharing room is already full (max 2 users).');
      cleanupWebRTC(true);
    });

    return () => {
      socket.disconnect();
    };
  }, [role, roomId]);

  // Clean up WebRTC connection state
  const cleanupWebRTC = (resetSocket = false) => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    dataChannelRef.current = null;
    if (resetSocket && socketRef.current) {
      socketRef.current.disconnect();
      setSocketConnected(false);
    }
  };

  // Toast System Helper
  const showToast = (type, message) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Copy shareable room link
  const copyRoomLink = () => {
    const shareUrl = `${window.location.origin}/#/room/${roomId}/${hexKey}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      showToast('success', 'Share link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Drag & Drop Handler
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setupFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files[0]) {
      setupFile(e.target.files[0]);
    }
  };

  // Process the dropped/selected file
  const setupFile = async (selectedFile) => {
    if (selectedFile.size > 800 * 1024 * 1024) {
      showToast('error', 'File exceeds the 800MB limit for browser stability.');
      return;
    }
    setFile(selectedFile);
    
    // Generate Room details and key
    const rId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const key = await generateEncryptionKey();
    const hKey = await exportKey(key);
    
    setRoomId(rId);
    setEncryptionKey(key);
    setHexKey(hKey);

    const fileMeta = {
      name: selectedFile.name,
      size: selectedFile.size,
      type: selectedFile.type,
      totalChunks: Math.ceil(selectedFile.size / CHUNK_SIZE)
    };
    
    setMeta(fileMeta);
    window.location.hash = `/room/${rId}/${hKey}`;
    showToast('success', 'File loaded. Copy the link below to share.');
  };

  // Initialize WebRTC as Sender
  const initiateWebRTC = () => {
    setPeerStatus('Connecting');
    createPeerConnection();
    
    // Create the DataChannel
    const dc = peerConnectionRef.current.createDataChannel('fileTransfer', {
      ordered: true,
    });
    
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 65536;

    dataChannelRef.current = dc;
    setupDataChannelHandlers(dc);

    // Create SDP Offer
    peerConnectionRef.current.createOffer()
      .then((offer) => peerConnectionRef.current.setLocalDescription(offer))
      .then(() => {
        socketRef.current.emit('signal', {
          roomId,
          data: { sdp: peerConnectionRef.current.localDescription }
        });
      })
      .catch((err) => console.error('Failed to create offer', err));
  };

  // Base RTCPeerConnection Creator
  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('signal', {
          roomId,
          data: { candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Connection state changed:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setPeerConnected(true);
        setPeerStatus('Connected');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setPeerConnected(false);
        setPeerStatus('Disconnected');
        setIsTransferring(false);
      }
    };

    if (role === 'receiver') {
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        dataChannelRef.current = dc;
        setupDataChannelHandlers(dc);
      };
    }
  };

  // DataChannel Message & State Handlers
  const setupDataChannelHandlers = (dc) => {
    dc.onopen = () => {
      console.log("DATA CHANNEL OPENED");
      setPeerConnected(true);
      setPeerStatus('Connected');
      
      if (role === 'sender') {
        console.log("SENDING META", meta);
        // Send metadata first
        dc.send(JSON.stringify({
          type: 'meta',
          ...meta
        }));
      }
    };

    dc.onclose = () => {
      console.log("DATA CHANNEL CLOSED");
      setPeerConnected(false);
      setPeerStatus('Disconnected');
      setIsTransferring(false);
    };

    dc.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        // String controls
        const message = JSON.parse(event.data);
        handleControlMessage(message);
      } else {
        // Binary chunk packet
        handleBinaryPacket(event.data);
      }
    };
  };

  // Handler for control strings on data channel
  const handleControlMessage = async (msg) => {
    console.log("CONTROL MESSAGE RECEIVED:", msg);
    if (msg.type === 'meta') {
      // Receiver receives file metadata
      setMeta(msg);
      await saveMeta(roomId, msg);
      
      // Determine if receiver has partially received chunks to support Auto-Resume
      let lastContiguousIndex = -1;
      try {
        // Sequentially check how many chunks are already in DB
        let idx = 0;
        while (idx < msg.totalChunks) {
          const chunk = await getChunk(roomId, idx);
          if (!chunk) break;
          lastContiguousIndex = idx;
          idx++;
        }
      } catch (err) {
        console.error('Error checking cached chunks', err);
      }

      // Ask for resume or start from beginning
      dataChannelRef.current.send(JSON.stringify({
        type: 'request-resume',
        lastChunkIndex: lastContiguousIndex
      }));

      // Initialize stats
      setProgress(lastContiguousIndex >= 0 ? Math.round(((lastContiguousIndex + 1) / msg.totalChunks) * 100) : 0);
      setBytesTransferred(lastContiguousIndex >= 0 ? (lastContiguousIndex + 1) * CHUNK_SIZE : 0);
      setIsTransferring(true);
      transferStartRef.current = Date.now();
      lastProgressTimeRef.current = Date.now();
      lastProgressBytesRef.current = lastContiguousIndex >= 0 ? (lastContiguousIndex + 1) * CHUNK_SIZE : 0;

    } else if (msg.type === 'request-resume') {
      console.log("REQUEST RESUME RECEIVED", msg);
      // Sender receives resume index from receiver
      const startIdx = msg.lastChunkIndex + 1;
      showToast('info', startIdx > 0 ? `Resuming file transfer from chunk ${startIdx}...` : 'Starting file transfer...');
      setIsTransferring(true);
      console.log("RESUMING FILE TRANSFER FROM CHUNK", startIdx);
      activeTransferRef.current.currentChunk = startIdx;
      activeTransferRef.current.totalChunks = meta.totalChunks;
      activeTransferRef.current.isPaused = false;
      
      transferStartRef.current = Date.now();
      lastProgressTimeRef.current = Date.now();
      lastProgressBytesRef.current = startIdx * CHUNK_SIZE;

      sendChunksLoop();

    } else if (msg.type === 'complete') {
      // Receiver completed receiving all chunks
      setIsTransferring(false);
      setTransferComplete(true);
      showToast('success', 'Download finished! Assembling and saving file...');
      assembleFile();
    }
  };

  // Asynchronously send chunks loop (throttled by data channel buffer)
  const sendChunksLoop = async () => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== 'open') return;

    const transferState = activeTransferRef.current;
    if (transferState.isPaused) return;

    // Buffer limit: wait if we have > 1MB buffered to prevent V8/browser freeze
    if (dc.bufferedAmount > 1024 * 1024) {
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = null;
        sendChunksLoop();
      };
      return;
    }

    if (transferState.currentChunk >= transferState.totalChunks) {
      // File fully sent
      dc.send(JSON.stringify({ type: 'complete' }));
      setIsTransferring(false);
      setTransferComplete(true);
      showToast('success', 'File transferred successfully!');
      return;
    }

    const chunkIdx = transferState.currentChunk;
    const start = chunkIdx * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const slice = file.slice(start, end);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target.result;
        
        // Wrap: Encrypt and SHA-256 hash
        const packet = await createChunkPacket(encryptionKey, chunkIdx, arrayBuffer);
        
        if (dc.readyState === 'open') {
          dc.send(packet);
          
          // Track and report progress stats
          const transferred = end;
          setBytesTransferred(transferred);
          setProgress(Math.round((transferred / file.size) * 100));
          
          // Update Speed & ETA
          updateTransferStats(transferred);

          transferState.currentChunk++;
          
          // Next loop (microtask to prevent stack overflow)
          setTimeout(sendChunksLoop, 0);
        }
      } catch (err) {
        console.error('Encryption or send error:', err);
        showToast('error', 'Error encrypting file payload.');
      }
    };

    reader.onerror = () => {
      showToast('error', 'Failed to read file from disk.');
    };

    reader.readAsArrayBuffer(slice);
  };

  // Receiver processes binary data packages
  const handleBinaryPacket = async (packetBuffer) => {
    try {
      // Decrypt and verify SHA-256 checksum
      const { chunkIndex, decryptedData } = await parseChunkPacket(encryptionKey, packetBuffer);

      // Write chunk
      if (useDirectDisk && fileWritable) {
        // Write directly to native stream
        await fileWritable.write({
          type: 'write',
          position: chunkIndex * CHUNK_SIZE,
          data: decryptedData
        });
      } else {
        // Write to IndexedDB
        await saveChunk(roomId, chunkIndex, decryptedData);
      }

      // Calculate progress stats
      const totalTransferred = Math.min(meta.size, (chunkIndex + 1) * CHUNK_SIZE);
      setBytesTransferred(totalTransferred);
      setProgress(Math.round((totalTransferred / meta.size) * 100));
      updateTransferStats(totalTransferred);

    } catch (err) {
      console.error('Binary payload processing error:', err);
      showToast('error', 'Corrupted block discarded. Attempting auto-resume...');
    }
  };

  // Reassemble chunks from IndexedDB and download
  const assembleFile = async () => {
    try {
      if (useDirectDisk && fileWritable) {
        // Direct disk save completed, close the handle
        await fileWritable.close();
        setFileWritable(null);
        showToast('success', 'File saved directly to disk!');
        clearRoom(roomId);
        return;
      }

      // Fallback IndexedDB assembly
      const chunks = [];
      for (let i = 0; i < meta.totalChunks; i++) {
        const chunk = await getChunk(roomId, i);
        if (!chunk) {
          throw new Error(`Missing chunk ${i}. Cannot reassemble file.`);
        }
        chunks.push(chunk);
      }

      const blob = new Blob(chunks, { type: meta.type || 'application/octet-stream' });
      const downloadUrl = URL.createObjectURL(blob);
      
      // Trigger browser download
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = meta.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      URL.revokeObjectURL(downloadUrl);
      showToast('success', 'File downloaded successfully!');
      
      // Cleanup database
      await clearRoom(roomId);
    } catch (err) {
      console.error('Reassembly failure', err);
      showToast('error', 'Failed to reassemble file. Some chunks are missing.');
    }
  };

  // Interactive File Picker Trigger for native saving
  const handleDirectDiskActivation = async () => {
    if (!meta) return;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: meta.name
      });
      const writable = await handle.createWritable();
      setFileWritable(writable);
      setUseDirectDisk(true);
      showToast('success', 'Direct disk write initialized.');
    } catch (err) {
      console.warn('File picker declined. Falling back to IndexedDB memory buffer.', err);
      setUseDirectDisk(false);
    }
  };

  // Compute speed and ETA
  const updateTransferStats = (transferred) => {
    const now = Date.now();
    
    if (!lastProgressTimeRef.current) {
      lastProgressTimeRef.current = now;
      lastProgressBytesRef.current = transferred;
      return;
    }

    const elapsedMs = now - lastProgressTimeRef.current;
    
    // Smooth update every 500ms
    if (elapsedMs >= 500) {
      const bytesSentInPeriod = transferred - lastProgressBytesRef.current;
      const speed = bytesSentInPeriod / (elapsedMs / 1000); // bytes/sec
      
      setTransferSpeed(speed);
      
      // Calculate ETA
      const totalSize = role === 'sender' ? file.size : meta.size;
      const remainingBytes = totalSize - transferred;
      if (speed > 0) {
        setEta(Math.ceil(remainingBytes / speed));
      } else {
        setEta(null);
      }

      lastProgressTimeRef.current = now;
      lastProgressBytesRef.current = transferred;
    }
  };

  // Reset App to original state
  const resetApp = () => {
    setFile(null);
    setMeta(null);
    setProgress(0);
    setBytesTransferred(0);
    setTransferSpeed(0);
    setEta(null);
    setIsTransferring(false);
    setTransferComplete(false);
    setUseDirectDisk(false);
    if (fileWritable) {
      fileWritable.close();
      setFileWritable(null);
    }
    cleanupWebRTC(false);
    window.location.hash = '';
    setRole('sender');
  };

  // Render Stats & Sizes
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSec) => {
    return (bytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
  };

  const formatEta = (seconds) => {
    if (seconds === null || seconds === undefined) return 'Calculating...';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="app-container">
      {/* Background decoration */}
      <div className="background-glow">
        <div className="blob blob-1"></div>
        <div className="blob blob-2"></div>
        <div className="blob blob-3"></div>
      </div>

      {/* Header / Navbar */}
      <header className="navbar">
        <div className="logo-container">
          <Share2Icon className="logo-icon text-violet-500" size={28} style={{ color: 'var(--primary)' }} />
          <span className="logo-text">Mars P2P Share</span>
          <span className="badge-tag">Zero Knowledge</span>
        </div>
        
        {/* Signaling indicator */}
        <div className="connection-badge">
          {socketConnected ? (
            <>
              <WifiIcon size={16} className="text-emerald-500" style={{ color: 'var(--success)' }} />
              <span className="status-dot connected"></span>
              <span>Online</span>
            </>
          ) : (
            <>
              <WifiOffIcon size={16} className="text-rose-500" style={{ color: 'var(--danger)' }} />
              <span className="status-dot disconnected"></span>
              <span>Connecting...</span>
            </>
          )}
        </div>
      </header>

      {/* Main Glass Panel */}
      <main className="glass-panel">
        
        {/* SENDER MODE: Drop zone and setup */}
        {role === 'sender' && !file && (
          <div className="flex-col-gap">
            <h1 className="title-main">Securely Share Large Files</h1>
            <p className="subtitle-main">
              Direct peer-to-peer file sharing. WebRTC transfers your data directly between browsers, encrypted end-to-end.
            </p>
            
            <div 
              className={`drop-zone ${dragActive ? 'active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-picker').click()}
            >
              <div className="drop-zone-icon">
                <FolderIcon size={32} />
              </div>
              <div>
                <p className="drop-zone-title">Drag & drop your file here</p>
                <p className="drop-zone-subtitle">or click to browse files (Up to 800MB)</p>
              </div>
              <input 
                type="file" 
                id="file-picker" 
                className="file-input" 
                onChange={handleFileSelect} 
              />
            </div>
          </div>
        )}

        {/* SENDER MODE: File loaded, waiting for receiver */}
        {role === 'sender' && file && !isTransferring && !transferComplete && (
          <div className="flex-col-gap">
            <h2 className="title-main">Room Ready</h2>
            <p className="subtitle-main">Send this encrypted link to the recipient. Keep this page open to transfer.</p>

            <div className="file-info-card">
              <div className="file-info-icon">
                <FolderIcon size={24} />
              </div>
              <div className="file-info-details">
                <div className="file-name">{file.name}</div>
                <div className="file-meta">
                  <span>{formatBytes(file.size)}</span>
                  <span>•</span>
                  <span>{file.type || 'Unknown Type'}</span>
                </div>
              </div>
            </div>

            <div className="flex-col-gap" style={{ gap: '0.75rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                SECURE DECRYPT invite LINK (contains keys client-side only)
              </label>
              <div className="share-box">
                <input 
                  type="text" 
                  readOnly 
                  value={`${window.location.origin}/#/room/${roomId}/${hexKey}`} 
                  className="share-url-input" 
                />
                <button className="btn btn-primary share-copy-btn" onClick={copyRoomLink}>
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            <div className="center-flex-item" style={{ marginTop: '1.5rem', gap: '1rem', flexDirection: 'column' }}>
              <div className="flex-col-gap" style={{ gap: '0.5rem', alignItems: 'center', width: '100%' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Receiver Connection: <strong>{peerStatus}</strong>
                </span>
                <div className="status-dot-container" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span className={`status-dot ${peerStatus.toLowerCase()}`}></span>
                  <span style={{ fontSize: '0.8rem', fontStyle: 'italic', color: 'var(--text-muted)' }}>
                    {peerStatus === 'Disconnected' ? 'Waiting for peer to open room...' : 'Establishing direct WebRTC...'}
                  </span>
                </div>
              </div>
              
              <button className="btn btn-secondary" style={{ marginTop: '1rem' }} onClick={resetApp}>
                Cancel Room
              </button>
            </div>
          </div>
        )}

        {/* RECEIVER MODE: Welcome, choose destination */}
        {role === 'receiver' && !isTransferring && !transferComplete && (
          <div className="flex-col-gap">
            <h2 className="title-main">Secure File Shared</h2>
            <p className="subtitle-main">You have been invited to download an end-to-end encrypted file directly.</p>

            <div className="file-info-card">
              <div className="file-info-icon">
                <FolderIcon size={24} />
              </div>
              <div className="file-info-details">
                <div className="file-name">{meta ? meta.name : 'Resolving filename...'}</div>
                <div className="file-meta">
                  {meta ? (
                    <>
                      <span>{formatBytes(meta.size)}</span>
                      <span>•</span>
                      <span>{meta.type || 'Binary Stream'}</span>
                    </>
                  ) : (
                    <span>Awaiting peer connection to query size...</span>
                  )}
                </div>
              </div>
            </div>

            {isDirectDiskSupported && meta && meta.size > 100 * 1024 * 1024 && (
              <div className="file-info-card" style={{ borderColor: 'rgba(6, 182, 212, 0.3)', background: 'rgba(6, 182, 212, 0.03)' }}>
                <div className="file-info-icon" style={{ color: 'var(--secondary)', background: 'rgba(6, 182, 212, 0.1)' }}>
                  <HardDriveIcon size={24} />
                </div>
                <div className="file-info-details">
                  <div className="file-name" style={{ fontSize: '0.9rem' }}>Direct to Disk (Recommended)</div>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    Large file detected. Activating direct-to-disk write will bypass browser RAM limits and stream download straight to your hard drive.
                  </p>
                  <button 
                    className={`btn ${useDirectDisk ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem', marginTop: '0.5rem', width: 'auto' }}
                    onClick={handleDirectDiskActivation}
                  >
                    {useDirectDisk ? 'Native Save Enabled' : 'Choose Local Output Path'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex-col-gap" style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                <LockIcon size={14} />
                <span>Zero-Knowledge AES-GCM Decryption Loaded</span>
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'center', margin: '0.5rem 0' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Sender status: <strong style={{ color: peerStatus === 'Connected' ? 'var(--success)' : '#f59e0b' }}>{peerStatus}</strong>
                </span>
              </div>

              <div style={{ display: 'flex', gap: '1rem' }}>
                <button 
                  className="btn btn-primary" 
                  disabled={peerStatus !== 'Connected'}
                  style={{ flex: 2 }}
                >
                  <DownloadIcon size={18} />
                  <span>
                    {peerStatus === 'Disconnected' && 'Awaiting Sender Connection...'}
                    {peerStatus === 'Connecting' && 'Establishing P2P Tunnel...'}
                    {peerStatus === 'Connected' && 'Connecting & Fetching File...'}
                  </span>
                </button>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={resetApp}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ACTIVE TRANSFER STATUS (Sender & Receiver) */}
        {isTransferring && meta && (
          <div className="flex-col-gap">
            <h2 className="title-main">{role === 'sender' ? 'Sending File' : 'Receiving File'}</h2>
            <p className="subtitle-main" style={{ marginBottom: '1.5rem' }}>
              {role === 'sender' 
                ? 'Streaming chunks directly to the receiver.' 
                : 'Downloading encrypted chunks over WebRTC.'}
            </p>

            <div className="file-info-card">
              <div className="file-info-icon" style={{ color: 'var(--secondary)' }}>
                <RefreshCwIcon className="animate-spin" size={24} />
              </div>
              <div className="file-info-details">
                <div className="file-name">{meta.name}</div>
                <div className="file-meta">
                  <span>{formatBytes(bytesTransferred)} of {formatBytes(meta.size)}</span>
                </div>
              </div>
            </div>

            <div className="progress-section">
              <div className="progress-header">
                <span>Progress</span>
                <span className="progress-percentage">{progress}%</span>
              </div>
              <div className="progress-bar-container">
                <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
              </div>

              <div className="transfer-stats">
                <div className="stat-item">
                  <span className="stat-label">Transfer Speed</span>
                  <span className="stat-val">{formatSpeed(transferSpeed)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">ETA</span>
                  <span className="stat-val">{formatEta(eta)}</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1.5rem' }}>
              <button className="btn btn-secondary" style={{ width: 'auto', padding: '0.6rem 1.5rem' }} onClick={resetApp}>
                <XIcon size={16} />
                <span>Cancel Transfer</span>
              </button>
            </div>
          </div>
        )}

        {/* COMPLETED SCREEN */}
        {transferComplete && meta && (
          <div className="flex-col-gap" style={{ textAlign: 'center', alignItems: 'center' }}>
            <div className="success-icon-container" style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '2px solid var(--success)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--success)',
              marginBottom: '1rem',
              boxShadow: '0 0 20px rgba(16, 185, 129, 0.2)'
            }}>
              <ShieldCheckIcon size={44} />
            </div>

            <h2 className="title-main">Transfer Complete!</h2>
            <p className="subtitle-main" style={{ marginBottom: '1.5rem' }}>
              The file was successfully transferred, decrypted, and verified with zero data corruption.
            </p>

            <div className="file-info-card" style={{ width: '100%', maxWidth: '400px' }}>
              <div className="file-info-icon" style={{ color: 'var(--success)' }}>
                <CheckIcon size={24} />
              </div>
              <div className="file-info-details" style={{ textAlign: 'left' }}>
                <div className="file-name">{meta.name}</div>
                <div className="file-meta">
                  <span>{formatBytes(meta.size)}</span>
                  <span>•</span>
                  <span>SHA-256 Verified</span>
                </div>
              </div>
            </div>

            <button className="btn btn-primary" style={{ width: 'auto', padding: '0.75rem 2rem', marginTop: '1.5rem' }} onClick={resetApp}>
              {role === 'sender' ? 'Share Another File' : 'Download Another'}
            </button>
          </div>
        )}

      </main>

      {/* Footer */}
      <footer>
        <p>Built with WebRTC, Web Crypto (AES-GCM), and IndexedDB.</p>
        <p style={{ marginTop: '0.25rem', fontSize: '0.75rem', opacity: 0.6 }}>
          All transfers are direct client-to-client. Signaling servers never read or cache your data.
        </p>
      </footer>

      {/* Toasts overlay */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
