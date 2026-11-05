import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Link } from '@/lib/navigation';
import { Callout } from '@/components/Callout';
import { Button, LinkButton } from '@/components/Button';
import { ApiError } from '@/lib/api';
import styles from './RouteError.module.css';

/** Route-level error boundary. Never renders transcript content — only error classes. */
export function RouteError() {
  const error = useRouteError();

  let title = 'Something went wrong';
  let detail = 'The page could not be rendered.';
  let code: string | null = null;

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? 'Page not found' : `Request failed (${error.status})`;
    detail = error.statusText || detail;
    code = String(error.status);
  } else if (error instanceof ApiError) {
    title = error.status === 0 ? 'The local server is not responding' : 'The local server returned an error';
    detail = error.message;
    code = error.code;
  } else if (error instanceof Error) {
    detail = error.message;
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>{title}</h1>
      <Callout tone="warn" title={code ? `Error ${code}` : 'Error'}>
        {detail}
      </Callout>
      <div className={styles.actions}>
        <Button variant="secondary" iconStart="chevron" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <LinkButton to="/" variant="ghost">
          Back to overview
        </LinkButton>
      </div>
      <p className={styles.hint}>
        If the server is not running, start it with <code>npm run dev</code>. See{' '}
        <Link to="/methodology">Methodology</Link> for what the numbers mean.
      </p>
    </div>
  );
}
