// Settings → Pricing Rules → "Show Cost Price" (server: backend/apps/company/cost_visibility.py).
// The profile carries `can_view_cost` (login + /api/auth/profile/), so a grid can pick its columns
// before its first request. Only `true` shows cost: a profile cached before the field existed hides
// it until the background profile refresh lands. The server leaves cost keys out for everyone
// else anyway — this only decides what the screen renders.
import { useAuth } from '../context/AuthContext';

export const canViewCost = (user) => user?.can_view_cost === true;

export const useCanViewCost = () => canViewCost(useAuth()?.user);
