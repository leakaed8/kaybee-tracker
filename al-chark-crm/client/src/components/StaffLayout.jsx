import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export default function StaffLayout() {
  const { user, logout } = useAuth();

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', padding: 12, borderBottom: '1px solid #ddd' }}>
        <strong>Al Chark — Staff</strong>
        <Link to="/staff/patients">Patients</Link>
        <Link to="/staff/visits/new">New visit</Link>
        <Link to="/staff/followups">Follow-ups</Link>
        <span style={{ marginLeft: 'auto' }}>{user?.name}</span>
        <button onClick={logout}>Log out</button>
      </header>
      <main style={{ padding: 16 }}>
        <Outlet />
      </main>
    </div>
  );
}
