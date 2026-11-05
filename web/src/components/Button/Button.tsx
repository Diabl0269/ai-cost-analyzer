import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { type LinkProps } from 'react-router';
import { Link } from '@/lib/navigation';
import { Icon, type IconName } from '@/components/Icon';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: IconName;
  iconEnd?: IconName;
  fullWidth?: boolean;
  children?: ReactNode;
}

function classes(props: CommonProps, extra?: string): string {
  return [
    styles.button,
    styles[props.variant ?? 'secondary'],
    styles[props.size ?? 'md'],
    props.fullWidth ? styles.full : null,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** shows a spinner and blocks activation; keeps the label for layout stability */
  loading?: boolean;
}

export function Button({
  variant,
  size,
  iconStart,
  iconEnd,
  fullWidth,
  loading = false,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, size, fullWidth }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : iconStart ? <Icon name={iconStart} /> : null}
      {children ? <span className={styles.label}>{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </button>
  );
}

export interface LinkButtonProps extends CommonProps, Omit<LinkProps, 'children'> {}

/** Same shape as `Button`, but it navigates. Use for anything that changes the URL. */
export function LinkButton({ variant, size, iconStart, iconEnd, fullWidth, children, className, ...rest }: LinkButtonProps) {
  return (
    <Link className={classes({ variant, size, fullWidth }, className)} {...rest}>
      {iconStart ? <Icon name={iconStart} /> : null}
      {children ? <span className={styles.label}>{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </Link>
  );
}
