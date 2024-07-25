import { formatRFC3339, formatDistanceToNowStrict } from 'date-fns';

const RecentPR = (props: any) => {
  const { pr } = props;
  const createdAtDate= new Date(pr.createdAt);
  const elapsedTime = <span title={formatRFC3339(createdAtDate)}>{formatDistanceToNowStrict(createdAtDate)} ago</span>;

  return (
    <div>
      {elapsedTime} {pr.author.login}&nbsp;
      <a href={pr.url} target="_blank" rel="noopener noreferrer">{`${pr.repository.name}/pull/${pr.number}`}</a>&nbsp;
      {pr.title}
    </div>
  );
}

export default RecentPR;
