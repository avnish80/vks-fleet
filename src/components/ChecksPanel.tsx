import { SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Typography } from '@mui/material';
import React from 'react';
import { CheckCategory, CheckResult, CheckStatus, Scorecard } from '../types';
import { ChartStyles, Donut, Slice, Tone } from './charts';

const STATUS: Record<CheckStatus, { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
  pass: { text: 'Pass', status: 'success' },
  warn: { text: 'Warning', status: 'warning' },
  fail: { text: 'Fail', status: 'error' },
  unknown: { text: 'Not checked', status: '' },
};

export function scoreTone(score: number): Tone {
  if (score >= 80) return 'success';
  if (score >= 60) return 'warning';
  return 'error';
}

const ORDER: CheckCategory[] = ['Resilience', 'Lifecycle', 'Security', 'Operations'];

export function ChecksPanel({ card }: { card: Scorecard }) {
  const counts = (s: CheckStatus) => card.checks.filter(c => c.status === s).length;
  return (
    <SectionBox title="Checks">
      <ChartStyles />
      <Box sx={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', mb: 2 }}>
        <Donut
          slices={([
            { label: 'Pass', value: counts('pass'), tone: 'success' },
            { label: 'Warning', value: counts('warn'), tone: 'warning' },
            { label: 'Fail', value: counts('fail'), tone: 'error' },
            { label: 'Not checked', value: counts('unknown'), tone: 'neutral' },
          ] as Slice[]).filter(s => s.value > 0)}
          centre={`${card.score}`}
          centreSub="score"
        />
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
          Best-practice checks for VKS clusters. The score weighs {card.evaluated} of {card.total} checks; checks that
          need a sign-in to the cluster don't count until they can run. A warning counts half.
        </Typography>
      </Box>
      {ORDER.map(cat => {
        const rows = card.checks.filter(c => c.category === cat);
        if (!rows.length) return null;
        return (
          <Box key={cat} sx={{ mb: 2 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              {cat}
            </Typography>
            <SimpleTable
              columns={[
                {
                  label: 'Result',
                  getter: (c: CheckResult) => <StatusLabel status={STATUS[c.status].status}>{STATUS[c.status].text}</StatusLabel>,
                },
                { label: 'Check', getter: (c: CheckResult) => c.title },
                { label: 'Details', getter: (c: CheckResult) => c.detail },
                { label: 'How to fix', getter: (c: CheckResult) => c.fix ?? '—' },
              ]}
              data={rows}
            />
          </Box>
        );
      })}
    </SectionBox>
  );
}
