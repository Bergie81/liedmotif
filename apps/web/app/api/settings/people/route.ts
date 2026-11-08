import { NextResponse } from 'next/server';
import {
  COVER_REFERENCE_FREQUENCIES,
  createPerson,
  ensureOwnerPerson,
  getCoverReferenceFrequency,
  listPeople,
  MAX_PEOPLE_PER_OWNER,
  MAX_PERSON_ABOUT_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  PersonLimitError,
  PersonNameConflictError,
  PersonValidationError,
  updateCoverReferenceFrequency,
  type CoverReferenceFrequency,
} from '@liedmotif/db';
import { getDb } from '@/lib/db';
import { readJsonObjectBody, requireOwnerId } from '@/lib/api-response';
import { toPersonSummary } from '@/lib/people';

export const dynamic = 'force-dynamic';

function error(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= maxLength ? text : null;
}

function isFrequency(value: unknown): value is CoverReferenceFrequency {
  return (COVER_REFERENCE_FREQUENCIES as readonly unknown[]).includes(value);
}

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const db = getDb();
  await ensureOwnerPerson(db, ownerUserId);
  const [people, coverReferenceFrequency] = await Promise.all([
    listPeople(db, ownerUserId),
    getCoverReferenceFrequency(db, ownerUserId),
  ]);
  return NextResponse.json({
    ok: true,
    people: people.map(toPersonSummary),
    coverReferenceFrequency,
    maxPeople: MAX_PEOPLE_PER_OWNER,
  });
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;

  if (Object.hasOwn(body, 'coverReferenceFrequency')) {
    if (!isFrequency(body.coverReferenceFrequency)) {
      return error('Choose Always, Regularly, Seldom, or Never.', 400);
    }
    await updateCoverReferenceFrequency(getDb(), ownerUserId, body.coverReferenceFrequency);
    return NextResponse.json({ ok: true, coverReferenceFrequency: body.coverReferenceFrequency });
  }

  const name = boundedText(body.name, MAX_PERSON_NAME_LENGTH);
  const about = boundedText(body.about ?? '', MAX_PERSON_ABOUT_LENGTH);
  if (!name) return error('Enter a Person name.', 400);
  if (about === null) {
    return error(`About must be at most ${MAX_PERSON_ABOUT_LENGTH} characters.`, 400);
  }
  try {
    const person = await createPerson(getDb(), { ownerUserId, name, about });
    return NextResponse.json({ ok: true, person: toPersonSummary(person) }, { status: 201 });
  } catch (caught) {
    if (caught instanceof PersonLimitError || caught instanceof PersonNameConflictError) {
      return error(caught.message, 409);
    }
    if (caught instanceof PersonValidationError) return error(caught.message, 400);
    throw caught;
  }
}
