import { createContext, useContext, useEffect, useState } from 'react';
import { apiFetch, getToken, setToken } from '../api/client';

const AuthContext = createContext(null);

function decodeUserFromToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return { id: payload.id, role: payload.role, name: payload.name };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const token = getToken();
    return token ? decodeUserFromToken(token) : null;
  });

  useEffect(() => {
    const token = getToken();
    if (token) setUser(decodeUserFromToken(token));
  }, []);

  async function loginStaff(username, password) {
    const data = await apiFetch('/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }

  async function loginPatient(phone, pin) {
    const data = await apiFetch('/auth/patient/login', {
      method: 'POST',
      body: JSON.stringify({ phone, pin }),
    });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loginStaff, loginPatient, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
