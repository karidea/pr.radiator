import React from 'react';
import { addWeeks, addDays, addHours, isAfter, formatRFC3339, formatDistanceToNowStrict } from 'date-fns';
import sortByCreatedAt from './utils';

type Event = {
	createdAt: string;
	author: string;
	state: string;
}

const combineReviewsAndComments = (reviews: any, comments: any) => {
	const events: Event[] = [];

  reviews.nodes.forEach((review: any) => {
    const event: Event = {
      createdAt: review.createdAt,
      author: review.author.login,
      state: review.state,
    }
    events.push(event);
  })

  comments.nodes.forEach((comment: any) => {
    const event: Event = {
      createdAt: comment.createdAt,
      author: comment.author.login,
      state: "ISSUECOMMENTED",
    }
    events.push(event);
  })

  return events.sort(sortByCreatedAt);
}

const getAgeString = (createdAt: Date) => {
  const current = new Date();
  if (isAfter(createdAt, addHours(current, -1))) {
    return 'last-hour';
  } else if (isAfter(createdAt, addHours(current, -2))){
    return 'last-two-hours';
  } else if (isAfter(createdAt, addDays(current, -1))){
    return 'last-day';
  } else if (isAfter(createdAt, addWeeks(current, -1))){
    return 'last-week';
  }
  return 'over-week-old';
}

const getCommitState = (headRefOid: string, timelineItems: any) => {
  const node = timelineItems.nodes.find((node: any) => {
    return node.commit.oid === headRefOid;
  });
  const [checkmark, circle, cross] = ['\u2714', '\u25cf', '\u2613'];
  const conclusion = node.commit?.checkSuites?.nodes[0]?.conclusion ?? node.commit.status;

  if (!conclusion) {
    return <span className="missing">-</span>;
  } else if (conclusion === 'SUCCESS') {
    return <span className="success">{checkmark}</span>;
  } else if (conclusion === 'STALE') {
    return <span className="pending">{circle}</span>;
  }

  return <span className="failed">{cross}</span>;
}

const TimelineEvent = (props: Event) => {
  const [checkmark, bubble, cross] = ['\u2714', '\u{0001F4AC}', '\u2613'];

  if (props.state === 'APPROVED') {
    return <span className="approved">{props.author} {checkmark} </span>;
  } else if (props.state === 'CHANGES_REQUESTED') {
    return <span className="changes-requested">{props.author} {cross} </span>;
  } else if (props.state === 'COMMENTED') {
    return <span className="commented">{props.author} {bubble} </span>;
  } else if (props.state === 'ISSUECOMMENTED') {
    return <span className="issue-commented">{props.author} {bubble} </span>;
  } else if (props.state === 'DISMISSED') {
    return <span className="dismissed">{props.author} - </span>;
  }
  return null;
}

const PR = (props: any) => {
  const { createdAt, reviews, comments, baseRefName, author, headRefOid, timelineItems, url, repository, title } = props.pr;
  const createdAtDate = new Date(createdAt);
  const events = combineReviewsAndComments(reviews, comments);
  const timeDistance = <span title={formatRFC3339(createdAtDate)}>{formatDistanceToNowStrict(createdAtDate)} ago</span>;
  const commitState = getCommitState(headRefOid, timelineItems);

  return (
    <div className={getAgeString(createdAtDate)}>
      {timeDistance} {baseRefName} {author.login} {commitState}&nbsp;
      <a href={url} target="_blank" rel="noopener noreferrer">{`${repository.name}/pull/${props.pr.number}`}</a>&nbsp;
      {title}
      <br />
      {events.map((event) => <TimelineEvent key={event.createdAt} {...event} />)}
    </div>
  );
}

export default PR;
