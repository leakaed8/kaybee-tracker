import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../api/client';

export default function PatientSearch() {
  const [query, setQuery] = useState('');
  const [patients, setPatients] = useState([]);
  const [error, setError] = useState('');

  async function search(q) {
    try {
      const results = await apiFetch(`/patients?q=${encodeURIComponent(q)}`);
      setPatients(results);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    search('');
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    search(query);
  }

  return (
    <div>
      <h2>Patients</h2>
      <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
        <input
          placeholder="Search by name or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit">Search</button>
      </form>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
            <th>Name</th>
            <th>Phone</th>
            <th>Tier</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {patients.map((p) => (
            <tr key={p.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>{p.name}</td>
              <td>{p.phone}</td>
              <td>{p.loyalty_tier}</td>
              <td>
                <Link to={`/staff/patients/${p.id}`}>View timeline</Link>{' '}
                | <Link to={`/staff/visits/new?patientId=${p.id}`}>New visit</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
