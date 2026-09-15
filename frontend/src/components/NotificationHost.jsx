import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Slide } from '@mui/material';
import { subscribeNotices, dismissNotice } from '../utils/notify';

// One notice: auto-hides after its duration, pauses while hovered.
function NoticeItem({ notice }) {
  const timerRef = useRef(null);
  const remainingRef = useRef(notice.duration);
  const startedRef = useRef(0);

  const start = () => {
    startedRef.current = Date.now();
    timerRef.current = setTimeout(() => dismissNotice(notice.id), remainingRef.current);
  };
  const pause = () => {
    clearTimeout(timerRef.current);
    remainingRef.current = Math.max(1500, remainingRef.current - (Date.now() - startedRef.current));
  };

  useEffect(() => {
    start();
    return () => clearTimeout(timerRef.current);
  }, []);

  return (
    <Slide direction="up" in mountOnEnter>
      <Alert
        severity={notice.severity}
        variant="filled"
        onClose={() => dismissNotice(notice.id)}
        onMouseEnter={pause}
        onMouseLeave={start}
        sx={{
          pointerEvents: 'auto',
          width: '100%',
          fontWeight: 600,
          boxShadow: 6,
          whiteSpace: 'pre-line',
          alignItems: 'center',
        }}
      >
        {notice.message}
      </Alert>
    </Slide>
  );
}

// Renders every notify()/alert() message as a stack at the bottom centre of the screen.
export default function NotificationHost() {
  const [notices, setNotices] = useState([]);
  useEffect(() => subscribeNotices(setNotices), []);

  if (!notices.length) return null;
  return (
    <Box
      sx={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        width: 'min(560px, calc(100vw - 32px))',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        zIndex: (theme) => theme.zIndex.snackbar + 10,
        pointerEvents: 'none',
      }}
    >
      {notices.map(n => <NoticeItem key={n.id} notice={n} />)}
    </Box>
  );
}
