import { useState, useEffect } from 'react';

/**
 * Custom hook to debounce fast-changing state (e.g. search query inputs)
 * @param {any} value The input value to debounce
 * @param {number} delay Delay in milliseconds (default: 200ms)
 */
export function useDebounce(value, delay = 200) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default useDebounce;
