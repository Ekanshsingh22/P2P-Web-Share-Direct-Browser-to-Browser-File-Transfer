import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: '*', // In development, allow all origins
  methods: ['GET', 'POST']
}));

app.get('/health', (req, res) => {
  res.send({ status: 'healthy', timestamp: new Date() });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Map to track room participants
// RoomID -> Set of { socketId, role }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join', ({ roomId, role }) => {
    console.log(`User ${socket.id} joining room ${roomId} as ${role}`);
    
    // Create room entry if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    const roomParticipants = rooms.get(roomId);

    // Limit room to 2 participants for core 1-to-1 direct transfers
    if (roomParticipants.size >= 2) {
      socket.emit('room-full', { roomId });
      console.log(`Room ${roomId} is full. User ${socket.id} rejected.`);
      return;
    }

    // Join socket room
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = role;

    const participantInfo = { socketId: socket.id, role };
    roomParticipants.add(participantInfo);

    // Notify other peers in the room
    socket.to(roomId).emit('peer-joined', {
      socketId: socket.id,
      role: role
    });

    // Send status back to the joining socket containing existing members
    const existingPeers = Array.from(roomParticipants)
      .filter(p => p.socketId !== socket.id);
    
    socket.emit('joined-successfully', {
      roomId,
      role,
      peers: existingPeers
    });
  });

  socket.on('signal', ({ roomId, data }) => {
    // Forward the signal to other users in the room
    socket.to(roomId).emit('signal', {
      senderId: socket.id,
      senderRole: socket.role,
      data
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const { roomId, role } = socket;

    if (roomId && rooms.has(roomId)) {
      const roomParticipants = rooms.get(roomId);
      
      // Remove this participant
      for (const p of roomParticipants) {
        if (p.socketId === socket.id) {
          roomParticipants.delete(p);
          break;
        }
      }

      // Notify remaining peers
      socket.to(roomId).emit('peer-left', {
        socketId: socket.id,
        role: role
      });

      // Clean up room if empty
      if (roomParticipants.size === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} is empty and deleted.`);
      }
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server running on port ${PORT}`);
});
