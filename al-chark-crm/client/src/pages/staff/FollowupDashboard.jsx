import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../api/client';

const STATUS_LABELS = {
  overdue: 'Overdue',
  due_today: 'Due today',
  upcoming: 'Upcoming',
  escalated: 'Escalated',
};

function waLink(phone, patientName) {
  const digits = phone.replace(/[^\d]/g, '');
  const message = `Hi ${patientName}, checking in on how you're doing since your last visit at Al Chark.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export default function FollowupDashboard() {
  const [followups, setFollowups] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      setFollowups(await apiFetch('/followups'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function logResponse(id, response) {
    try {
      await apiFetch(`/followups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ response, status: response === 'worse' ? 'escalated' : 'closed' }),
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h2>Follow-up dashboard</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
            <th>Patient</th>
            <th>Scheduled</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {followups.map((f) => (
            <tr key={f.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>
                <Link to={`/staff/patients/${f.patient_id}`}>{f.patient_name}</Link>
              </td>
              <td>{f.scheduled_date}</td>
              <td>{STATUS_LABELS[f.dashboard_status] || f.dashboard_status}</td>
              <td>
                <a href={waLink(f.patient_phone, f.patient_name)} target="_blank" rel="noreferrer">
                  WhatsApp
                </a>{' '}
                <button onClick={() => logResponse(f.id, 'better')}>Better</button>
                <button onClick={() => logResponse(f.id, 'same')}>Same</button>
                <button onClick={() => logResponse(f.id, 'worse')}>Worse</button>
                <button onClick={() => logResponse(f.id, 'no_response')}>No response</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
