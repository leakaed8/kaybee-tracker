import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch } from '../../api/client';

export default function PatientTimeline() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch(`/patients/${id}`).then(setData).catch((err) => setError(err.message));
  }, [id]);

  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!data) return <p>Loading…</p>;

  const { patient, visits, followups } = data;

  return (
    <div>
      <h2>{patient.name}</h2>
      <p>
        {patient.phone} · Tier: {patient.loyalty_tier} ·{' '}
        <Link to={`/staff/visits/new?patientId=${patient.id}`}>Log a new visit</Link>
      </p>

      <h3>Visit history</h3>
      {visits.length === 0 && <p>No visits yet.</p>}
      {visits.map((v) => (
        <div key={v.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 10 }}>
          <strong>{new Date(v.visit_date).toLocaleDateString()}</strong> — seen by {v.staff_name}
          <p><b>Complaint:</b> {v.complaint || '—'}</p>
          <p><b>Assessment:</b> {v.assessment || '—'}</p>
          <p><b>Lifestyle advice:</b> {v.lifestyle_advice || '—'}</p>
          {v.products.length > 0 && (
            <p><b>Products:</b> {v.products.map((p) => p.product_name).join(', ')}</p>
          )}
          {v.next_followup_date && (
            <p><b>Next follow-up:</b> {v.next_followup_date}</p>
          )}
        </div>
      ))}

      <h3>Follow-ups</h3>
      {followups.length === 0 && <p>No follow-ups logged.</p>}
      <ul>
        {followups.map((f) => (
          <li key={f.id}>
            {f.scheduled_date} — {f.status} {f.response ? `(${f.response})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
