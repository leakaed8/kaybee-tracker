import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute';
import StaffLayout from './components/StaffLayout';
import Login from './pages/Login';
import MyCare from './pages/patient/MyCare';
import FollowupDashboard from './pages/staff/FollowupDashboard';
import PatientSearch from './pages/staff/PatientSearch';
import PatientTimeline from './pages/staff/PatientTimeline';
import VisitEntry from './pages/staff/VisitEntry';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        path="/staff"
        element={
          <ProtectedRoute roles={['staff', 'admin']}>
            <StaffLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="patients" replace />} />
        <Route path="patients" element={<PatientSearch />} />
        <Route path="patients/:id" element={<PatientTimeline />} />
        <Route path="visits/new" element={<VisitEntry />} />
        <Route path="followups" element={<FollowupDashboard />} />
      </Route>

      <Route
        path="/patient"
        element={
          <ProtectedRoute roles={['patient']}>
            <MyCare />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
