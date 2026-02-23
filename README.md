# 🧠 Memory Vault - Digital Wisdom Preservation System

A beautiful, animated web application for preserving and organizing human wisdom, knowledge, and experiences across different vaults.

## 🚀 Quick Start

### Prerequisites

- Node.js (v14+)
- npm or yarn

### Installation & Setup

1. **Install dependencies:**

```bash
npm install
```

1. **Start the backend server:**

```bash
npm start
```

The backend will run on `http://localhost:3000`

1. **Open in browser:**
   Navigate to `http://localhost:3000` to access the application

## 📋 Features

✨ **beautiful animations** - Cool gradient backgrounds, glowing effects, and smooth transitions
🔐 **Secure Authentication** - JWT-based signin/signup with password hashing
📦 **Data Persistence** - Backend database with user-specific memory storage
🎭 **Multiple Vaults**:

- Personal Life Vault (PIN-protected diary)
- Knowledge & Education
- Cultural Heritage
- Future Wisdom
  🤖 **AI Assistant** - Chat with an AI to manage and query your memories
  🌍 **Responsive Design** - Works on desktop and mobile devices

## 🏗️ Architecture

### Frontend

- **HTML**: Clean semantic structure
- **CSS**: Advanced animations, gradients, and responsive design
- **JavaScript**: State management, API communication, form handling

### Backend

- **Node.js + Express**: RESTful API server
- **JWT Authentication**: Secure token-based auth
- **Bcrypt**: Password hashing
- **File-based Storage**: JSON persistence (can be upgraded to database)

## 📡 API Endpoints

### Authentication

```text
POST /api/auth/signup    - Create new account
POST /api/auth/signin    - Login with credentials
```

### Memories

```text
GET  /api/memories       - Get all user memories
POST /api/memories       - Create new memory
DELETE /api/memories/:id - Delete memory
```

## 🎨 Cool Features

- **Animated Background**: Cosmic glow effects with floating earth globe
- **Smooth Transitions**: Form animations, page transitions, hover effects
- **Glow Animations**: Pulsing button effects and glowing inputs
- **Responsive**: Adapts to all screen sizes
- **Dark Theme**: Easy on the eyes with beautiful gradients

## 🔒 Security

- Password hashing with bcryptjs
- JWT token-based authentication
- Protected API endpoints
- User-isolated data storage

## 📝 Usage

1. **Sign Up**: Create a new account to get started
1. **Sign In**: Login to access your memory vaults
1. **Create Memories**: Add memories to different vaults
1. **PIN Protection**: Protect your personal diary with a PIN
1. **AI Assistant**: Use the AI chat to query and manage memories

## 🛠️ Development

To run in development mode with hot reload:

```bash
npm run dev
```

## 📄 File Structure

```text
Memory Vault/
├── backend/server.js     # Backend Express server
├── package.json          # Dependencies
├── backend/users.json    # User data (created on first run)
├── backend/memory_vault_knowledge.json # Verified app knowledge used by AI
└── src/
    ├── index.html        # Main HTML file
    ├── styles.css        # Styling with animations
    ├── script.js         # Frontend logic
    └── netlify-config.js # Frontend API URL config
```

## 🎯 Next Steps

- [ ] Upgrade to MongoDB/PostgreSQL for scalability
- [ ] Add OAuth integration (Google, GitHub)
- [ ] Implement memory search and filtering
- [ ] Add image uploads for memories
- [ ] Create mobile app version
- [ ] Add export/backup functionality

## 🤖 AI Knowledge Base

Memory Vault AI now reads a curated knowledge file: `backend/memory_vault_knowledge.json`.

- Add or edit entries in this file to teach the assistant accurate product facts.
- Each entry supports `topic`, `keywords`, `answer`, and `sources`.
- This global knowledge is combined with each logged-in user's own memories during AI chat.

---

Created with ❤️ by Ijabor Blossom | February 2026

