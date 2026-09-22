import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

export function PageHeading({ children }: { children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { key } = useLocation();
  useEffect(() => {
    heading.current?.focus();
  }, [key]);
  return (
    <h1 ref={heading} tabIndex={-1}>
      {children}
    </h1>
  );
}
