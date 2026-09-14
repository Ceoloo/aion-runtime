/**
 * AIO-17 contract payload validation for GHL CRM actions.
 * Pure functions — used by the adapter and by fixture tests.
 */

import type { GhlMutationKind } from './types.js';

export interface PayloadValidationError {
  code: 'PAYLOAD_INVALID';
  message: string;
  field?: string;
}

function missing(field: string): PayloadValidationError {
  return {
    code: 'PAYLOAD_INVALID',
    message: `${field} is required`,
    field,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Validate action payloads before provider I/O.
 * Returns null when the payload is acceptable for the action.
 */
export function validateGhlPayload(
  action: GhlMutationKind,
  payload: Record<string, unknown>,
): PayloadValidationError | null {
  switch (action) {
    case 'contact.read':
      if (!str(payload['contactId']) && !str(payload['email'])) {
        return missing('contactId|email');
      }
      return null;
    case 'contact.search':
      return null;
    case 'contact.enrich':
    case 'contact.update': {
      const hasId = !!str(payload['contactId']);
      const hasEmail = !!str(payload['email']);
      if (!hasId && !hasEmail) return missing('contactId|email');
      return null;
    }
    case 'opportunity.read':
      if (!str(payload['opportunityId'])) return missing('opportunityId');
      return null;
    case 'opportunity.search':
      return null;
    case 'opportunity.create':
      if (!str(payload['contactId'])) return missing('contactId');
      if (!str(payload['pipelineId']) && !str(payload['name'])) {
        // name is defaulted by backends; pipeline is strongly preferred
        return null;
      }
      return null;
    case 'opportunity.update':
      if (!str(payload['opportunityId'])) return missing('opportunityId');
      if (
        !str(payload['stage']) &&
        !str(payload['stageId']) &&
        !str(payload['pipelineStageId']) &&
        !str(payload['name']) &&
        typeof payload['value'] !== 'number'
      ) {
        return {
          code: 'PAYLOAD_INVALID',
          message: 'opportunity.update requires stage, name, or value',
        };
      }
      return null;
    case 'pipeline.read':
      return null;
    case 'conversation.read':
      // Defined for AIO-17 fixtures; capability is disabled at the adapter gate.
      if (
        !str(payload['conversationId']) &&
        !str(payload['contactId'])
      ) {
        return missing('conversationId|contactId');
      }
      return null;
    case 'conversation.send':
      if (!str(payload['contactId']) && !str(payload['conversationId'])) {
        return missing('contactId|conversationId');
      }
      if (!str(payload['body']) && !str(payload['message'])) {
        return missing('body');
      }
      return null;
    case 'appointment.read':
      return null;
    case 'appointment.create':
      if (!str(payload['contactId'])) return missing('contactId');
      if (!str(payload['startAt']) && !str(payload['startTime'])) {
        return missing('startAt');
      }
      if (!str(payload['title']) && !str(payload['calendarId'])) {
        return {
          code: 'PAYLOAD_INVALID',
          message: 'appointment.create requires title or calendarId',
          field: 'title',
        };
      }
      return null;
    case 'note.create':
      if (!str(payload['contactId'])) return missing('contactId');
      if (!str(payload['body'])) return missing('body');
      return null;
    case 'task.create':
      if (!str(payload['contactId'])) return missing('contactId');
      if (!str(payload['title'])) return missing('title');
      return null;
    case 'message.draft':
    case 'message.send':
      if (!str(payload['contactId'])) return missing('contactId');
      if (!str(payload['body'])) return missing('body');
      return null;
    default: {
      const _exhaustive: never = action;
      return {
        code: 'PAYLOAD_INVALID',
        message: `unsupported action: ${_exhaustive}`,
      };
    }
  }
}
