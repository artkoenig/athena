export function createEmptyMetrics() {
  return {
    session: {
      id: "unknown",
      format: "unknown",
      provider: "unknown",
      model: "unknown",
      startTime: null,
      endTime: null,
      durationMs: 0
    },
    counts: {
      stepCount: 0,
      toolCallsTotal: 0,
      toolCallsFailed: 0,
      errorCount: 0
    },
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0
    },
    toolBreakdown: {},
    errors: []
  };
}

export function aggregateMetrics(turns, format, provider) {
  const metrics = createEmptyMetrics();
  metrics.session.format = format;
  metrics.session.provider = provider;
  
  if (turns.length > 0) {
    const firstTurn = turns[0];
    const lastTurn = turns[turns.length - 1];
    metrics.session.startTime = firstTurn.timestamp || new Date().toISOString();
    metrics.session.endTime = lastTurn.timestamp || new Date().toISOString();
    metrics.session.durationMs = new Date(metrics.session.endTime).getTime() - new Date(metrics.session.startTime).getTime();
  }

  metrics.counts.stepCount = turns.length;
  
  for (const turn of turns) {
    if (turn.errors && turn.errors.length > 0) {
      metrics.counts.errorCount += turn.errors.length;
      turn.errors.forEach(err => {
        metrics.errors.push({
          step: turn.step,
          tool: err.tool || 'unknown',
          errorType: err.errorType || 'unknown',
          message: err.message || err
        });
      });
    }

    if (turn.toolCalls) {
      for (const call of turn.toolCalls) {
        metrics.counts.toolCallsTotal++;
        if (!call.success) {
          metrics.counts.toolCallsFailed++;
        }
        
        if (!metrics.toolBreakdown[call.name]) {
          metrics.toolBreakdown[call.name] = { total: 0, success: 0, failed: 0 };
        }
        metrics.toolBreakdown[call.name].total++;
        if (call.success) {
          metrics.toolBreakdown[call.name].success++;
        } else {
          metrics.toolBreakdown[call.name].failed++;
        }
      }
    }
  }

  // Token aggregation should be passed separately if parsed, or we can assume it's attached to turns.
  // Wait, tokens can be global per turn. Let's say turn.tokens is an object.
  for (const turn of turns) {
    if (turn.tokens) {
      metrics.tokens.inputTokens += turn.tokens.inputTokens || 0;
      metrics.tokens.outputTokens += turn.tokens.outputTokens || 0;
      metrics.tokens.cacheReadTokens += turn.tokens.cacheReadTokens || 0;
      metrics.tokens.cacheCreationTokens += turn.tokens.cacheCreationTokens || 0;
    }
  }
  
  metrics.tokens.totalTokens = metrics.tokens.inputTokens + metrics.tokens.outputTokens + metrics.tokens.cacheReadTokens + metrics.tokens.cacheCreationTokens;

  return metrics;
}

export function normalizeSession(turns, format, provider) {
  const metrics = aggregateMetrics(turns, format, provider);
  return {
    metadata: {
      sessionId: metrics.session.id,
      format,
      provider
    },
    metrics,
    turns
  };
}
