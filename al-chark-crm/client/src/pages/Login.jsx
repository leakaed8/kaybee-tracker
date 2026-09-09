import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export default function Login() {
  const [mode, setMode] = useState('staff'); // 'staff' | 'patient'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const { loginStaff, loginPatient } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'staff') {
        await loginStaff(username, password);
        navigate('/staff/patients');
      } else {
        await loginPatient(phone, pin);
        navigate('/patient');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'sans-serif' }}>
      <h1>Al Chark Patient CRM</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={() => setMode('staff')} disabled={mode === 'staff'}>
          Staff login
        </button>
        <button type="button" onClick={() => setMode('patient')} disabled={mode === 'patient'}>
          Patient login
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mode === 'staff' ? (
          <>
            <input
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : (
          <>
            <input
              placeholder="Phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <input
              type="password"
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </>
        )}

        {error && <p style={{ color: 'crimson' }}>{error}</p>}
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
