import { Alert, Box, Button, Typography } from '@mui/material';
import React, { ErrorInfo, ReactNode } from 'react';

interface State {
  error?: Error;
  info?: string;
  copied?: boolean;
}

/**
 * Keeps one failing part from blanking the whole page: shows what failed,
 * with "Try again" and "Copy details" (for a bug report), and leaves the
 * rest of the page working.
 */
export class Guard extends React.Component<{ name: string; children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? undefined });
    console.error(`vks-fleet: ${this.props.name} failed to render`, error);
  }

  render() {
    const { error, info, copied } = this.state;
    if (!error) return this.props.children;
    const details = [`${this.props.name} failed to render`, `Page: ${typeof window !== 'undefined' ? window.location.pathname : ''}`, `Error: ${error.message}`, error.stack ?? '', info ?? ''].join('\n');
    return (
      <Box sx={{ my: 1 }}>
        <Alert
          severity="error"
          action={
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                size="small"
                onClick={() => {
                  navigator.clipboard?.writeText(details);
                  this.setState({ copied: true });
                }}
              >
                {copied ? 'Copied' : 'Copy details'}
              </Button>
              <Button size="small" onClick={() => this.setState({ error: undefined, info: undefined, copied: false })}>
                Try again
              </Button>
            </Box>
          }
        >
          <Typography variant="body2">
            <b>{this.props.name}</b> couldn't be shown: {error.message}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            The rest of the page still works. If this keeps happening, "Copy details" gives what's needed for a bug report.
          </Typography>
        </Alert>
      </Box>
    );
  }
}
