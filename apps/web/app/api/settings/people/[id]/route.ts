import { NextResponse } from 'next/server';
import {
  deletePerson,
  MAX_PERSON_ABOUT_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  PersonNameConflictError,
  PersonValidationError,
  updatePerson,
} from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { readJsonObjectBody, requireOwnerId } from '@/lib/http/api-response';
import { toPersonSummary } from '@/lib/settings/people';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function error(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= maxLength ? text : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;
  const name = boundedText(body.name, MAX_PERSON_NAME_LENGTH);
  const about = boundedText(body.about ?? '', MAX_PERSON_ABOUT_LENGTH);
  if (!name) return error('Enter a Person name.', 400);
  if (about === null) {
    return error(`About must be at most ${MAX_PERSON_ABOUT_LENGTH} characters.`, 400);
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return error('Person not found.', 404);
  try {
    const person = await updatePerson(getDb(), {
      ownerUserId,
      personId: id,
      name,
      about,
    });
    if (!person) return error('Person not found.', 404);
    return NextResponse.json({ ok: true, person: toPersonSummary(person) });
  } catch (caught) {
    if (caught instanceof PersonNameConflictError) return error(caught.message, 409);
    if (caught instanceof PersonValidationError) return error(caught.message, 400);
    throw caught;
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return error('Person not found.', 404);
  const result = await deletePerson(getDb(), { ownerUserId, personId: id });
  if (result === 'not_found') return error('Person not found.', 404);
  if (result === 'owner') return error('The owner Person cannot be deleted.', 400);
  return NextResponse.json({ ok: true, deleted: true });
}
