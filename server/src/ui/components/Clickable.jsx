import React from 'react';
import { Box } from 'ink';
import { useOnClick } from '../mouse.jsx';

/**
 * A Box that responds to mouse clicks.
 *
 * Exists as a component because `useOnClick` is a hook: it cannot be called
 * from inside the .map() callbacks that render the expandable rows.
 */
export function Clickable({ onClick, children, ...boxProps }) {
  const ref = React.useRef(null);
  useOnClick(ref, onClick);
  return (
    <Box ref={ref} {...boxProps}>
      {children}
    </Box>
  );
}
