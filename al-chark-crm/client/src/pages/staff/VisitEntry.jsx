import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../api/client';

export default function VisitEntry() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [patientId, setPatientId] = useState(searchParams.get('patientId') || '');
  const [complaint, setComplaint] = useState('');
  const [assessment, setAssessment] = useState('');
  const [lifestyleAdvice, setLifestyleAdvice] = useState('');
  const [nextFollowupDate, setNextFollowupDate] = useState('');
  const [products, setProducts] = useState([]);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiFetch('/products').then(setProducts).catch((err) => setError(err.message));
  }, []);

  function toggleProduct(id) {
    setSelectedProductIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    try {
      await apiFetch('/visits', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: Number(patientId),
          complaint,
          assessment,
          lifestyle_advice: lifestyleAdvice,
          next_followup_date: nextFollowupDate || null,
          products: selectedProductIds.map((product_id) => ({ product_id })),
        }),
      });
      setSuccess('Visit logged.');
      setTimeout(() => navigate(`/staff/patients/${patientId}`), 600);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ maxWidth: 500 }}>
      <h2>New visit</h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label>
          Patient ID
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} required />
        </label>
        <label>
          Complaint
          <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} />
        </label>
        <label>
          Assessment
          <textarea value={assessment} onChange={(e) => setAssessment(e.target.value)} />
        </label>
        <label>
          Lifestyle advice
          <textarea value={lifestyleAdvice} onChange={(e) => setLifestyleAdvice(e.target.value)} />
        </label>
        <label>
          Next follow-up date
          <input
            type="date"
            value={nextFollowupDate}
            onChange={(e) => setNextFollowupDate(e.target.value)}
          />
        </label>

        <fieldset>
          <legend>Products / supplements used</legend>
          {products.map((p) => (
            <label key={p.id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={selectedProductIds.includes(p.id)}
                onChange={() => toggleProduct(p.id)}
              />
              {p.name}
            </label>
          ))}
        </fieldset>

        {error && <p style={{ color: 'crimson' }}>{error}</p>}
        {success && <p style={{ color: 'green' }}>{success}</p>}
        <button type="submit">Save visit</button>
      </form>
    </div>
  );
}
