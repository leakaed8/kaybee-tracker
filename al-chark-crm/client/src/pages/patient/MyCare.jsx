import { useAuth } from '../../auth/AuthContext';

// Placeholder patient landing page. The full read-only care timeline,
// progress photos, and shop are later build-order steps (5+).
export default function MyCare() {
  const { user, logout } = useAuth();

  return (
    <div style={{ maxWidth: 500, margin: '60px auto', fontFamily: 'sans-serif' }}>
      <h1>Welcome, {user?.name}</h1>
      <p>Your care timeline, notifications, and shop are coming soon.</p>
      <button onClick={logout}>Log out</button>
    </div>
  );
}
