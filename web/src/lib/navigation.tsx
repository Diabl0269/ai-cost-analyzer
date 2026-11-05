import { forwardRef, useCallback } from 'react';
import {
  Link as RouterLink, NavLink as RouterNavLink, useLocation,
  useNavigate as useRouterNavigate, type LinkProps, type NavLinkProps,
  type NavigateFunction, type NavigateOptions, type To,
} from 'react-router';
import { withProvider } from './provider.js';

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, ...props }, ref) {
  const { search } = useLocation();
  return <RouterLink {...props} ref={ref} to={withProvider(to, search)} />;
});

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink({ to, ...props }, ref) {
  const { search } = useLocation();
  return <RouterNavLink {...props} ref={ref} to={withProvider(to, search)} />;
});

export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate();
  const { search } = useLocation();
  return useCallback(((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') return navigate(to);
    return navigate(withProvider(to, search), options);
  }) as NavigateFunction, [navigate, search]);
}
